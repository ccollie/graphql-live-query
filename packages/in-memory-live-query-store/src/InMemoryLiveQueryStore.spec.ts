import {
  GraphQLID,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from "graphql";
import { InMemoryLiveQueryStore } from "./InMemoryLiveQueryStore";

const isAsyncIterable = (value: unknown): value is AsyncIterable<unknown> => {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
};

const getAllValues = async <T>(values: AsyncIterableIterator<T>) => {
  const results: T[] = [];

  for await (const value of values) {
    results.push(value);
  }

  return results;
};

const createTestSchema = (
  mutableSource: {
    query?: string;
    mutation?: string;
    post?: {
      id: string;
      title: string;
    };
  } = {
    query: "queried",
    mutation: "mutated",
    post: {
      id: "1",
      title: "lel",
    },
  }
) => {
  const GraphQLPostType = new GraphQLObjectType({
    name: "Post",
    fields: {
      id: {
        type: GraphQLNonNull(GraphQLID),
      },
      title: {
        type: GraphQLString,
      },
    },
  });
  const Query = new GraphQLObjectType({
    name: "Query",
    fields: {
      foo: {
        type: GraphQLString,
        resolve: () => mutableSource.query,
      },
      post: {
        type: GraphQLPostType,
        args: {
          id: {
            type: GraphQLID,
          },
        },
        resolve: () => mutableSource.post,
      },
    },
  });
  const Mutation = new GraphQLObjectType({
    name: "Mutation",
    fields: {
      foo: {
        type: GraphQLString,
        resolve: () => mutableSource.mutation,
      },
    },
  });

  return new GraphQLSchema({ query: Query, mutation: Mutation });
};

describe("conformance with default `graphql-js` exports", () => {
  // The tests ins here a snapshot tests to ensure consistent behavior with the default GraphQL functions
  // that are used inside InMemoryLiveQueryStore.execute

  test("returns a sync query result in case no query operation with @live is provided", () => {
    const store = new InMemoryLiveQueryStore();
    const schema = createTestSchema();
    const document = parse(/* GraphQL */ `
      query {
        foo
      }
    `);
    const result = store.execute({
      document,
      schema,
    });

    expect(result).toEqual({
      data: {
        foo: "queried",
      },
    });
  });

  test("returns a sync mutation result", () => {
    const store = new InMemoryLiveQueryStore();
    const schema = createTestSchema();
    const document = parse(/* GraphQL */ `
      mutation {
        foo
      }
    `);

    const result = store.execute({
      document,
      schema,
    });

    expect(result).toEqual({
      data: {
        foo: "mutated",
      },
    });
  });

  test("returns an error in case a document without an operation is provided", () => {
    const store = new InMemoryLiveQueryStore();
    const schema = createTestSchema();
    const document = parse(/* GraphQL */ `
      fragment FooFragment on Query {
        foo
      }
    `);

    const result = store.execute({
      document,
      schema,
    });

    // stay conform with original execute behavior
    expect(result).toMatchInlineSnapshot(`
      Object {
        "errors": Array [
          [GraphQLError: Must provide an operation.],
        ],
      }
    `);
  });

  test("returns an error in case multiple operations but no matching operationName is provided.", () => {
    const store = new InMemoryLiveQueryStore();
    const schema = createTestSchema();
    const document = parse(/* GraphQL */ `
      query a {
        foo
      }
      query b {
        foo
      }
    `);

    const result = store.execute({
      document,
      schema,
    });

    // stay conform with original execute behavior
    expect(result).toMatchInlineSnapshot(`
      Object {
        "errors": Array [
          [GraphQLError: Must provide operation name if query contains multiple operations.],
        ],
      }
    `);
  });
});

it("returns a AsyncIterable that publishes a query result.", async () => {
  const schema = createTestSchema();
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query @live {
      foo
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }
  const result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        foo: "queried",
      },
      isLive: true,
    },
  });
  executionResult.return?.();
});

it("returns a AsyncIterable that publishes a query result after the schema coordinate was invalidated.", async () => {
  const mutableSource = { query: "queried", mutation: "mutated" };
  const schema = createTestSchema(mutableSource);
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query @live {
      foo
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }

  let result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        foo: "queried",
      },
      isLive: true,
    },
  });

  mutableSource.query = "changed";
  store.invalidate("Query.foo");

  result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        foo: "changed",
      },
      isLive: true,
    },
  });

  executionResult.return?.();
});

it("returns a AsyncIterable that publishes a query result after the resource identifier was invalidated.", async () => {
  const schema = createTestSchema();
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query @live {
      post {
        id
        title
      }
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }

  let result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        post: {
          id: "1",
          title: "lel",
        },
      },
      isLive: true,
    },
  });

  store.invalidate("Post:1");

  result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        post: {
          id: "1",
          title: "lel",
        },
      },
      isLive: true,
    },
  });

  executionResult.return?.();
});

it("does not publish when a old resource identifier is invalidated", async () => {
  const mutableSource = {
    post: {
      id: "1",
      title: "lel",
    },
  };
  const schema = createTestSchema(mutableSource);
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query @live {
      post {
        id
        title
      }
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }

  let result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        post: {
          id: "1",
          title: "lel",
        },
      },
      isLive: true,
    },
  });

  mutableSource.post.id = "2";
  store.invalidate("Post:1");

  result = await executionResult.next();
  expect(result).toEqual({
    done: false,
    value: {
      data: {
        post: {
          id: "2",
          title: "lel",
        },
      },
      isLive: true,
    },
  });

  store.invalidate("Post:1");
  const nextResult = executionResult.next();

  executionResult.return?.();
  result = await nextResult;
  expect(result).toMatchInlineSnapshot(`
    Object {
      "done": true,
      "value": undefined,
    }
  `);
});

it("can be executed with polymorphic parameter type", () => {
  const mutableSource = { query: "queried", mutation: "mutated" };
  const schema = createTestSchema(mutableSource);
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query {
      foo
    }
  `);

  const executionResult = store.execute(schema, document);
  expect(executionResult).toEqual({
    data: {
      foo: "queried",
    },
  });
});

it("can handle missing NoLiveMixedWithDeferStreamRule", async () => {
  const schema = createTestSchema();
  const store = new InMemoryLiveQueryStore();
  const document = parse(/* GraphQL */ `
    query @live {
      ... on Query @defer(label: "kek") {
        foo
      }
    }
  `);

  const executionResult = await store.execute(schema, document);
  if (isAsyncIterable(executionResult)) {
    const result = await executionResult.next();
    expect(result).toMatchInlineSnapshot(`
      Object {
        "done": false,
        "value": Object {
          "errors": Array [
            [GraphQLError: "execute" returned a AsyncIterator instead of a MaybePromise<ExecutionResult>. The "NoLiveMixedWithDeferStreamRule" rule might have been skipped.],
          ],
        },
      }
    `);

    return;
  }
  fail("Should return AsyncIterable");
});

it("can collect additional resource identifiers with 'extensions.liveQuery.collectResourceIdentifiers'", async () => {
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        ping: {
          type: GraphQLString,
          args: {
            id: {
              type: GraphQLNonNull(GraphQLString),
            },
          },
          extensions: {
            liveQuery: {
              collectResourceIdentifiers: (_: unknown, args: { id: string }) =>
                args.id,
            },
          },
        },
      },
    }),
  });
  const document = parse(/* GraphQL */ `
    query @live {
      ping(id: "1")
    }
  `);
  const store = new InMemoryLiveQueryStore();
  const executionResult = await store.execute(schema, document);

  if (!isAsyncIterable(executionResult)) {
    fail("should return AsyncIterable");
  }

  store.invalidate("1");

  process.nextTick(() => {
    executionResult.return?.();
  });

  const values = await getAllValues(executionResult);
  expect(values).toHaveLength(2);
});

it("adds the resource identifiers as a extension field.", async () => {
  const schema = createTestSchema();
  const store = new InMemoryLiveQueryStore({
    includeIdentifierExtension: true,
  });
  const document = parse(/* GraphQL */ `
    query ($id: ID!) @live {
      post(id: $id) {
        id
        title
      }
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
    variableValues: {
      id: "1",
    },
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }

  let result = await executionResult.next();
  expect(result).toMatchInlineSnapshot(`
    Object {
      "done": false,
      "value": Object {
        "data": Object {
          "post": Object {
            "id": "1",
            "title": "lel",
          },
        },
        "extensions": Object {
          "liveResourceIdentifier": Array [
            "Query.post",
            "Query.post(id:\\"1\\")",
            "Post:1",
          ],
        },
        "isLive": true,
      },
    }
  `);

  await executionResult.return?.();
});

it("can set the id field name arbitrarily", async () => {
  const arbitraryIdName = "whateverIWant";

  const GraphQLPostType = new GraphQLObjectType({
    name: "Post",
    fields: {
      [arbitraryIdName]: {
        type: GraphQLNonNull(GraphQLID),
      },
      title: {
        type: GraphQLString,
      },
    },
  });

  const Query = new GraphQLObjectType({
    name: "Query",
    fields: {
      post: {
        type: GraphQLPostType,
        args: {
          id: {
            type: GraphQLID,
          },
        },
        resolve: () => ({
          [arbitraryIdName]: "1",
          title: "lel",
        }),
      },
    },
  });

  const schema = new GraphQLSchema({ query: Query });

  const store = new InMemoryLiveQueryStore({
    includeIdentifierExtension: true,
    idFieldName: arbitraryIdName,
  });

  const document = parse(/* GraphQL */ `
    query($id: ID!) @live {
      post(id: $id) {
        ${arbitraryIdName}
        title
      }
    }
  `);

  const executionResult = store.execute({
    schema,
    document,
    variableValues: {
      id: "1",
    },
  });

  if (!isAsyncIterable(executionResult)) {
    return fail(
      `result should be a AsyncIterable. Got ${typeof executionResult}.`
    );
  }

  let result = await executionResult.next();

  expect(result.value.extensions.liveResourceIdentifier).toEqual([
    "Query.post",
    'Query.post(id:"1")',
    "Post:1",
  ]);
});
