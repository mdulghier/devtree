import { readFileSync, writeFileSync } from "node:fs";

import ts from "typescript";

import type { Devtree_config } from "./config.ts";

function get_property_name_text(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function get_object_literal_from_source_file(source_file: ts.SourceFile) {
  for (const statement of source_file.statements) {
    if (!ts.isExportAssignment(statement)) {
      continue;
    }

    const export_expression = statement.expression;

    if (ts.isObjectLiteralExpression(export_expression)) {
      return export_expression;
    }

    if (
      ts.isCallExpression(export_expression) &&
      export_expression.arguments.length > 0 &&
      ts.isObjectLiteralExpression(export_expression.arguments[0])
    ) {
      return export_expression.arguments[0];
    }
  }

  throw new Error("Could not find an exported devtree config object in devtree.config.ts.");
}

function get_property_assignment(object_literal: ts.ObjectLiteralExpression, segment: string) {
  return object_literal.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      property.name !== undefined &&
      get_property_name_text(property.name) === segment,
  );
}

function create_property_name(segment: string) {
  return /^[$A-Z_a-z][$\w]*$/u.test(segment)
    ? ts.factory.createIdentifier(segment)
    : ts.factory.createStringLiteral(segment);
}

function json_value_to_expression(value: unknown): ts.Expression {
  if (value === null) {
    return ts.factory.createNull();
  }

  if (typeof value === "boolean") {
    return value ? ts.factory.createTrue() : ts.factory.createFalse();
  }

  if (typeof value === "number") {
    return ts.factory.createNumericLiteral(value);
  }

  if (typeof value === "string") {
    return ts.factory.createStringLiteral(value);
  }

  if (Array.isArray(value)) {
    return ts.factory.createArrayLiteralExpression(value.map(json_value_to_expression), true);
  }

  if (typeof value !== "object") {
    throw new Error("Config values must be JSON-compatible objects, arrays, or primitives.");
  }

  return ts.factory.createObjectLiteralExpression(
    Object.entries(value as Record<string, unknown>).map(([key, entry_value]) =>
      ts.factory.createPropertyAssignment(create_property_name(key), json_value_to_expression(entry_value)),
    ),
    true,
  );
}

function parse_value_expression(raw_value: string) {
  const trimmed_value = raw_value.trim();

  if (trimmed_value === "true") {
    return ts.factory.createTrue();
  }

  if (trimmed_value === "false") {
    return ts.factory.createFalse();
  }

  if (trimmed_value === "null") {
    return ts.factory.createNull();
  }

  if (trimmed_value === "undefined") {
    return ts.factory.createIdentifier("undefined");
  }

  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed_value)) {
    return ts.factory.createNumericLiteral(trimmed_value);
  }

  if (
    (trimmed_value.startsWith("{") && trimmed_value.endsWith("}")) ||
    (trimmed_value.startsWith("[") && trimmed_value.endsWith("]")) ||
    (trimmed_value.startsWith('"') && trimmed_value.endsWith('"'))
  ) {
    try {
      return json_value_to_expression(JSON.parse(trimmed_value));
    } catch {
      return ts.factory.createStringLiteral(raw_value);
    }
  }

  return ts.factory.createStringLiteral(raw_value);
}

function print_node(node: ts.Node, source_file: ts.SourceFile) {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

  return printer.printNode(ts.EmitHint.Unspecified, node, source_file);
}

function create_nested_object_literal(segments: string[], value: ts.Expression): ts.ObjectLiteralExpression {
  const [segment, ...rest] = segments;

  if (!segment) {
    throw new Error("Config path cannot be empty.");
  }

  return ts.factory.createObjectLiteralExpression(
    [
      ts.factory.createPropertyAssignment(
        create_property_name(segment),
        rest.length === 0 ? value : create_nested_object_literal(rest, value),
      ),
    ],
    true,
  );
}

type Replacement_plan = {
  target: ts.Node;
  replacement: ts.Node;
};

function plan_config_update(
  object_literal: ts.ObjectLiteralExpression,
  segments: string[],
  value: ts.Expression,
): Replacement_plan {
  const [segment, ...rest] = segments;

  if (!segment) {
    throw new Error("Config path cannot be empty.");
  }

  const existing_property = get_property_assignment(object_literal, segment);

  if (rest.length === 0) {
    if (existing_property) {
      return {
        target: existing_property.initializer,
        replacement: value,
      };
    }

    return {
      target: object_literal,
      replacement: ts.factory.updateObjectLiteralExpression(object_literal, [
        ...object_literal.properties,
        ts.factory.createPropertyAssignment(create_property_name(segment), value),
      ]),
    };
  }

  if (!existing_property) {
    return {
      target: object_literal,
      replacement: ts.factory.updateObjectLiteralExpression(object_literal, [
        ...object_literal.properties,
        ts.factory.createPropertyAssignment(
          create_property_name(segment),
          create_nested_object_literal(rest, value),
        ),
      ]),
    };
  }

  if (!ts.isObjectLiteralExpression(existing_property.initializer)) {
    throw new Error(`Cannot set ${segments.join(".")} because ${segment} is not an object.`);
  }

  return plan_config_update(existing_property.initializer, rest, value);
}

function get_config_path_segments(config_path: string) {
  const segments = config_path
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Config path cannot be empty.");
  }

  return segments;
}

export function get_config_value(config: Devtree_config, config_path: string) {
  let current_value: unknown = config;

  for (const segment of get_config_path_segments(config_path)) {
    if (current_value === null || typeof current_value !== "object" || !(segment in current_value)) {
      return undefined;
    }

    current_value = (current_value as Record<string, unknown>)[segment];
  }

  return current_value;
}

export function format_config_value(value: unknown) {
  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "function") {
    return "[function]";
  }

  return JSON.stringify(value, null, 2);
}

export function update_config_text(source_text: string, config_path: string, raw_value: string) {
  const source_file = ts.createSourceFile(
    "devtree.config.ts",
    source_text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const root_object_literal = get_object_literal_from_source_file(source_file);
  const replacement_plan = plan_config_update(
    root_object_literal,
    get_config_path_segments(config_path),
    parse_value_expression(raw_value),
  );

  return [
    source_text.slice(0, replacement_plan.target.getStart(source_file)),
    print_node(replacement_plan.replacement, source_file),
    source_text.slice(replacement_plan.target.getEnd()),
  ].join("");
}

export function set_config_value(config_file_path: string, config_path: string, raw_value: string) {
  const source_text = readFileSync(config_file_path, "utf8");
  const next_text = update_config_text(source_text, config_path, raw_value);

  writeFileSync(config_file_path, next_text);
}
