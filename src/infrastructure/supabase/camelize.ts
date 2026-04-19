// Boundary helpers between snake_case (Postgres / PostgREST) and camelCase (TS).
// Per architecture.md § Naming Patterns → Component-to-DB translation rule:
// the conversion happens once, here, and nowhere else. Features must never see
// snake_case identifiers; SQL must never see camelCase identifiers.

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function transformKeys<T>(value: unknown, transform: (key: string) => string): T {
  if (Array.isArray(value)) {
    return value.map((item) => transformKeys(item, transform)) as T;
  }
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const [key, val] of Object.entries(value)) {
      out[transform(key)] = transformKeys(val, transform);
    }
    return out as T;
  }
  return value as T;
}

export function camelize<T = unknown>(value: unknown): T {
  return transformKeys<T>(value, snakeToCamel);
}

export function decamelize<T = unknown>(value: unknown): T {
  return transformKeys<T>(value, camelToSnake);
}
