/**
 * A tiny schema DSL for `.hardhooks.json`: each schema validates a JSON value
 * (collecting every problem with its JSON path), emits JSON Schema for editors,
 * and carries the TypeScript type it describes. Hand-written rather than a
 * library because we need only a handful of JSON types, exact error messages,
 * JSON Schema output and zero bundle cost.
 */

/** A JSON Schema document fragment. */
export type JsonSchema = { readonly [key: string]: unknown };

export type PathSegment = string | number;

export interface Issue {
  readonly path: readonly PathSegment[];
  readonly message: string;
}

export interface Schema<T> {
  /** Type-level only: the value type this schema describes. */
  readonly _type?: T;
  /** Every problem with `value`, or none. `path` locates `value` in the document. */
  validate(value: unknown, path: readonly PathSegment[]): Issue[];
  toJsonSchema(): JsonSchema;
}

/** A property that may be left out of its object. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
  readonly inner: Schema<T>;
}

export interface ObjectSchema<T> extends Schema<T> {
  readonly properties: Readonly<Record<string, Schema<unknown>>>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Shape = Record<string, Schema<any>>;
type ObjectType<P extends Shape> = Simplify<
  { -readonly [K in keyof P as P[K] extends OptionalSchema<any> ? never : K]: Infer<P[K]> } & {
    -readonly [K in keyof P as P[K] extends OptionalSchema<any> ? K : never]?: Exclude<Infer<P[K]>, undefined>;
  }
>;

interface Described {
  /** Shown by editors on hover. */
  description?: string;
}

/** "a string", "an array", "null", ... for error messages. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return `a string (${JSON.stringify(value)})`;
  if (typeof value === "number") return `a number (${value})`;
  if (typeof value === "boolean") return `a boolean (${value})`;
  return typeof value;
}

const issue = (path: readonly PathSegment[], message: string): Issue[] => [{ path, message }];

function withDescription(schema: JsonSchema, options: Described | undefined): JsonSchema {
  return options?.description === undefined ? schema : { description: options.description, ...schema };
}

function primitive<T>(type: "boolean" | "string", options?: Described): Schema<T> {
  return {
    validate: (value, path) => (typeof value === type ? [] : issue(path, `expected a ${type}, got ${describeType(value)}`)),
    toJsonSchema: () => withDescription({ type }, options),
  };
}

export function boolean(options?: Described): Schema<boolean> {
  return primitive("boolean", options);
}

export function string(options?: Described): Schema<string> {
  return primitive("string", options);
}

export function number(options?: Described & { integer?: boolean; minimum?: number; maximum?: number }): Schema<number> {
  const { integer, minimum, maximum } = options ?? {};
  return {
    validate(value, path) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return issue(path, `expected ${integer ? "an integer" : "a number"}, got ${describeType(value)}`);
      }
      if (integer && !Number.isInteger(value)) return issue(path, `expected an integer, got ${value}`);
      if (minimum !== undefined && value < minimum) return issue(path, `must be at least ${minimum}, got ${value}`);
      if (maximum !== undefined && value > maximum) return issue(path, `must be at most ${maximum}, got ${value}`);
      return [];
    },
    toJsonSchema: () =>
      withDescription(
        {
          type: integer ? "integer" : "number",
          ...(minimum !== undefined ? { minimum } : {}),
          ...(maximum !== undefined ? { maximum } : {}),
        },
        options,
      ),
  };
}

/** One of a fixed set of strings. */
export function oneOf<const V extends readonly string[]>(values: V, options?: Described): Schema<V[number]> {
  return {
    validate: (value, path) =>
      typeof value === "string" && values.includes(value)
        ? []
        : issue(path, `expected one of ${values.map((v) => JSON.stringify(v)).join(", ")}, got ${describeType(value)}`),
    toJsonSchema: () => withDescription({ enum: [...values] }, options),
  };
}

export function array<T>(items: Schema<T>, options?: Described): Schema<T[]> {
  return {
    validate(value, path) {
      if (!Array.isArray(value)) return issue(path, `expected an array, got ${describeType(value)}`);
      return value.flatMap((item, index) => items.validate(item, [...path, index]));
    },
    toJsonSchema: () => withDescription({ type: "array", items: items.toJsonSchema() }, options),
  };
}

export function optional<T>(inner: Schema<T>): OptionalSchema<T> {
  return {
    optional: true,
    inner,
    validate: (value, path) => (value === undefined ? [] : inner.validate(value, path)),
    toJsonSchema: () => inner.toJsonSchema(),
  };
}

const isOptional = (schema: Schema<unknown>): schema is OptionalSchema<unknown> =>
  (schema as Partial<OptionalSchema<unknown>>).optional === true;

export interface ObjectOptions extends Described {
  /** Message for a key not in `properties`. Default: `unknown key "<key>"`. */
  unknownKey?: (key: string) => string;
}

/** A JSON object with exactly these properties; unknown keys are errors. */
export function object<P extends Shape>(properties: P, options?: ObjectOptions): ObjectSchema<ObjectType<P>> {
  const unknownKey = options?.unknownKey ?? ((key: string) => `unknown key ${JSON.stringify(key)}`);
  return {
    properties,
    validate(value, path) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return issue(path, `expected an object, got ${describeType(value)}`);
      }
      const record = value as Record<string, unknown>;
      const issues: Issue[] = [];
      for (const [key, schema] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key)) {
          if (!isOptional(schema)) issues.push({ path, message: `missing required key ${JSON.stringify(key)}` });
          continue;
        }
        issues.push(...schema.validate(record[key], [...path, key]));
      }
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) issues.push({ path: [...path, key], message: unknownKey(key) });
      }
      return issues;
    },
    toJsonSchema() {
      const required = Object.entries(properties)
        .filter(([, schema]) => !isOptional(schema))
        .map(([key]) => key);
      return withDescription(
        {
          type: "object",
          properties: Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema.toJsonSchema()])),
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
        },
        options,
      );
    },
  };
}

/** The same object with every top-level property optional (config files override defaults key by key). */
export function partial<T>(schema: ObjectSchema<T>, options?: ObjectOptions): ObjectSchema<Partial<T>> {
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, property]) => [key, isOptional(property) ? property : optional(property)]),
  );
  return object(properties, options) as unknown as ObjectSchema<Partial<T>>;
}

/** `hooks.git-guard.protectedBranches[0]`, or `(top level)` for the root. */
export function formatPath(path: readonly PathSegment[]): string {
  if (path.length === 0) return "(top level)";
  return path
    .map((segment, i) => (typeof segment === "number" ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join("");
}
