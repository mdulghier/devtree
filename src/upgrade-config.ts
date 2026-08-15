import ts from "typescript";

type Config_property = ts.PropertyAssignment & {
  name: ts.PropertyName;
};

export type Upgrade_allocation = {
  id: number;
  line: number;
  source: string;
  automatable: boolean;
};

export type Upgrade_config_analysis = {
  has_legacy_keys: boolean;
  has_endpoints: boolean;
  initial_project_name: string;
  allocations: Upgrade_allocation[];
  has_custom_hostname: boolean;
};

function get_property_name_text(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function unwrap_expression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrap_expression(expression.expression);
  }

  return expression;
}

function get_config_object(source_file: ts.SourceFile) {
  for (const statement of source_file.statements) {
    if (!ts.isExportAssignment(statement)) {
      continue;
    }

    const expression = unwrap_expression(statement.expression);

    if (ts.isObjectLiteralExpression(expression)) {
      return expression;
    }

    if (ts.isCallExpression(expression) && expression.arguments.length > 0) {
      const config_argument = unwrap_expression(expression.arguments[0]);

      if (ts.isObjectLiteralExpression(config_argument)) {
        return config_argument;
      }
    }
  }

  throw new Error("Could not find an exported Devtree config object.");
}

function get_config_property(config_object: ts.ObjectLiteralExpression, property_name: string) {
  return config_object.properties.find(
    (property): property is Config_property =>
      ts.isPropertyAssignment(property) && get_property_name_text(property.name) === property_name,
  );
}

function read_string_initializer(property: Config_property | undefined) {
  const initializer = property && unwrap_expression(property.initializer);

  return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
}

function is_supported_callback(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function binding_contains_name(binding: ts.ObjectBindingPattern, name: string) {
  return binding.elements.some(
    (element) => ts.isIdentifier(element.name) && element.name.text === name,
  );
}

function find_dependency_callback(node: ts.Node) {
  let current_node: ts.Node | undefined = node.parent;

  while (current_node) {
    if (is_supported_callback(current_node)) {
      const first_parameter = current_node.parameters[0];

      if (
        first_parameter &&
        ts.isObjectBindingPattern(first_parameter.name) &&
        binding_contains_name(first_parameter.name, "instance")
      ) {
        return current_node;
      }
    }

    current_node = current_node.parent;
  }

  return null;
}

function is_instance_port_allocation(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  return (
    node.expression.name.text === "allocate_port" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "instance"
  );
}

function collect_allocations(source_file: ts.SourceFile) {
  const allocations: Upgrade_allocation[] = [];

  function visit(node: ts.Node) {
    if (is_instance_port_allocation(node)) {
      const start = node.getStart(source_file);
      const line = source_file.getLineAndCharacterOfPosition(start).line + 1;

      allocations.push({
        id: start,
        line,
        source: node.getText(source_file),
        automatable: find_dependency_callback(node) !== null,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(source_file);
  return allocations;
}

function has_custom_hostname(config_object: ts.ObjectLiteralExpression) {
  for (const config_name of ["routing", "portless"]) {
    const config_property = get_config_property(config_object, config_name);

    if (!config_property) {
      continue;
    }

    const config_initializer = unwrap_expression(config_property.initializer);

    if (
      ts.isObjectLiteralExpression(config_initializer) &&
      get_config_property(config_initializer, "hostname")
    ) {
      return true;
    }
  }

  return false;
}

export function analyze_upgrade_config(config_text: string): Upgrade_config_analysis {
  const source_file = ts.createSourceFile(
    "devtree.config.ts",
    config_text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const config_object = get_config_object(source_file);
  const project_name = read_string_initializer(get_config_property(config_object, "project_name"));
  const app_name = read_string_initializer(get_config_property(config_object, "app_name"));
  const namespace = read_string_initializer(get_config_property(config_object, "namespace"));

  return {
    has_legacy_keys: Boolean(
      get_config_property(config_object, "app_name") ||
      get_config_property(config_object, "namespace"),
    ),
    has_endpoints: Boolean(get_config_property(config_object, "endpoints")),
    initial_project_name: project_name ?? app_name ?? namespace ?? "my-project",
    allocations: collect_allocations(source_file),
    has_custom_hostname: has_custom_hostname(config_object),
  };
}

function create_property_name(name: string) {
  return /^[$A-Z_a-z][$\w]*$/u.test(name)
    ? ts.factory.createIdentifier(name)
    : ts.factory.createStringLiteral(name);
}

function create_endpoints_property(endpoint_name: string) {
  return ts.factory.createPropertyAssignment(
    "endpoints",
    ts.factory.createObjectLiteralExpression(
      [
        ts.factory.createPropertyAssignment(
          create_property_name(endpoint_name),
          ts.factory.createObjectLiteralExpression(
            [
              ts.factory.createPropertyAssignment("primary", ts.factory.createTrue()),
              ts.factory.createPropertyAssignment(
                "target",
                ts.factory.createObjectLiteralExpression(
                  [
                    ts.factory.createPropertyAssignment(
                      "kind",
                      ts.factory.createStringLiteral("dev-server"),
                    ),
                  ],
                  true,
                ),
              ),
            ],
            true,
          ),
        ),
      ],
      true,
    ),
  );
}

function add_dependencies_parameter(callback: ts.ArrowFunction | ts.FunctionExpression) {
  const first_parameter = callback.parameters[0];

  if (!first_parameter || !ts.isObjectBindingPattern(first_parameter.name)) {
    return callback.parameters;
  }

  if (binding_contains_name(first_parameter.name, "dependencies")) {
    return callback.parameters;
  }

  const next_binding = ts.factory.updateObjectBindingPattern(first_parameter.name, [
    ...first_parameter.name.elements,
    ts.factory.createBindingElement(undefined, undefined, "dependencies"),
  ]);
  const next_parameter = ts.factory.updateParameterDeclaration(
    first_parameter,
    first_parameter.modifiers,
    first_parameter.dotDotDotToken,
    next_binding,
    first_parameter.questionToken,
    first_parameter.type,
    first_parameter.initializer,
  );

  return ts.factory.createNodeArray([next_parameter, ...callback.parameters.slice(1)]);
}

function update_callback_parameters(callback: ts.ArrowFunction | ts.FunctionExpression) {
  const parameters = add_dependencies_parameter(callback);

  if (ts.isArrowFunction(callback)) {
    return ts.factory.updateArrowFunction(
      callback,
      callback.modifiers,
      callback.typeParameters,
      parameters,
      callback.type,
      callback.equalsGreaterThanToken,
      callback.body,
    );
  }

  return ts.factory.updateFunctionExpression(
    callback,
    callback.modifiers,
    callback.asteriskToken,
    callback.name,
    callback.typeParameters,
    parameters,
    callback.type,
    callback.body,
  );
}

function migrate_config_object(
  config_object: ts.ObjectLiteralExpression,
  project_name: string,
  endpoint_name: string | null,
) {
  const next_properties: ts.ObjectLiteralElementLike[] = [];
  let wrote_project_name = false;

  for (const property of config_object.properties) {
    const name = ts.isPropertyAssignment(property)
      ? get_property_name_text(property.name)
      : undefined;

    if (name === "project_name" || name === "app_name" || name === "namespace") {
      if (!wrote_project_name) {
        const project_property = ts.factory.createPropertyAssignment(
          "project_name",
          ts.factory.createStringLiteral(project_name),
        );
        ts.setOriginalNode(project_property, property);
        next_properties.push(project_property);
        wrote_project_name = true;

        if (endpoint_name) {
          next_properties.push(create_endpoints_property(endpoint_name));
        }
      }

      continue;
    }

    next_properties.push(property);
  }

  if (!wrote_project_name) {
    next_properties.unshift(
      ts.factory.createPropertyAssignment(
        "project_name",
        ts.factory.createStringLiteral(project_name),
      ),
    );

    if (endpoint_name) {
      next_properties.splice(1, 0, create_endpoints_property(endpoint_name));
    }
  } else if (
    endpoint_name &&
    !next_properties.some(
      (property) =>
        ts.isPropertyAssignment(property) && get_property_name_text(property.name) === "endpoints",
    )
  ) {
    next_properties.splice(1, 0, create_endpoints_property(endpoint_name));
  }

  return ts.factory.updateObjectLiteralExpression(config_object, next_properties);
}

export function migrate_upgrade_config(
  config_text: string,
  options: {
    project_name: string;
    endpoint_name: string | null;
    dependency_allocation_ids: number[];
  },
) {
  const source_file = ts.createSourceFile(
    "devtree.config.ts",
    config_text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const config_object = get_config_object(source_file);
  const selected_ids = new Set(options.dependency_allocation_ids);
  const callbacks_to_update = new Set<ts.ArrowFunction | ts.FunctionExpression>();

  function find_selected_callbacks(node: ts.Node) {
    if (is_instance_port_allocation(node) && selected_ids.has(node.getStart(source_file))) {
      const callback = find_dependency_callback(node);

      if (callback) {
        callbacks_to_update.add(callback);
      }
    }

    ts.forEachChild(node, find_selected_callbacks);
  }

  find_selected_callbacks(source_file);

  const transformation = ts.transform(source_file, [
    (context) => {
      const visitor: ts.Visitor = (node) => {
        let next_node = ts.visitEachChild(node, visitor, context);

        if (
          is_instance_port_allocation(node) &&
          selected_ids.has(node.getStart(source_file)) &&
          ts.isCallExpression(next_node) &&
          ts.isPropertyAccessExpression(next_node.expression)
        ) {
          next_node = ts.factory.updateCallExpression(
            next_node,
            ts.factory.updatePropertyAccessExpression(
              next_node.expression,
              ts.factory.createIdentifier("dependencies"),
              next_node.expression.name,
            ),
            next_node.typeArguments,
            next_node.arguments,
          );
        }

        if (
          callbacks_to_update.has(node as ts.ArrowFunction | ts.FunctionExpression) &&
          is_supported_callback(next_node)
        ) {
          next_node = update_callback_parameters(next_node);
        }

        if (node === config_object && ts.isObjectLiteralExpression(next_node)) {
          next_node = migrate_config_object(next_node, options.project_name, options.endpoint_name);
        }

        return next_node;
      };

      return (root_node) => ts.visitNode(root_node, visitor) as ts.SourceFile;
    },
  ]);
  const migrated_source = transformation.transformed[0] as ts.SourceFile;
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const output = printer.printFile(migrated_source);

  transformation.dispose();
  return output.endsWith("\n") ? output : `${output}\n`;
}
