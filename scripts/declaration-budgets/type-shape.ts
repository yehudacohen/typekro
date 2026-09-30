/**
 * Structural type-shape hashing for the public API snapshot.
 *
 * A symbol's hash covers the full structure of every type its signature
 * depends on, recursively:
 *
 * - Public exports (symbols that have their own snapshot line) are referenced
 *   by their public name, since their own line already covers their shape.
 * - Types from dependencies and the TypeScript lib are referenced by module
 *   path and name, plus their type arguments.
 * - Every other type is expanded: non-exported interfaces, classes, type
 *   aliases and enums, anonymous object and function types, unions and
 *   intersections, tuples, mapped, conditional, indexed-access and template
 *   literal types. Expansion walks properties, call and construct signatures
 *   (type parameters, parameters, `this`, return types, predicates), index
 *   signatures and type arguments. Inherited members are part of a type's
 *   properties, so `extends` is covered through them.
 *
 * Non-exported types are expanded by structure only; their names are not part
 * of the hash. Consumers cannot refer to a non-exported type by name, so
 * renaming one without changing its structure leaves every hash unchanged.
 *
 * Recursive and mutually recursive types terminate: a type already on the
 * expansion stack is written as a relative back-reference (`^n`), and
 * expansions deeper than MAX_DEPTH are cut. Acyclic expansions are memoized
 * (as a text hash when long), so shared structure is expanded once.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { compareText } from './graph.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Deep generic expansions (for example `Deep<T[]>`) stop here. */
const MAX_DEPTH = 64;

interface Shape {
  text: string;
  /**
   * Whether the expansion contains a back-reference or a depth cut. Only
   * acyclic expansions are memoized: their text does not depend on which types
   * are on the stack, so reusing them keeps every hash independent of the order
   * symbols and members are visited in.
   */
  cyclic: boolean;
}

export interface TypeShapeHasherOptions {
  checker: ts.TypeChecker;
  /** Public symbol (alias-resolved) to the name its snapshot line uses. */
  publicNames: ReadonlyMap<ts.Symbol, string>;
  /** Whether a source file belongs to the package (as opposed to a dependency or the lib). */
  isPackageFile: (fileName: string) => boolean;
  /** Makes a dependency file name location-independent. */
  externalModuleName: (fileName: string) => string;
}

export class TypeShapeHasher {
  private readonly checker: ts.TypeChecker;
  private readonly memo = new Map<ts.Type, string>();
  private readonly stack: ts.Type[] = [];
  private root: ts.Symbol | undefined;

  constructor(private readonly options: TypeShapeHasherOptions) {
    this.checker = options.checker;
  }

  /** Hash of a symbol's value type and declared type, expanded structurally. */
  hashSymbol(symbol: ts.Symbol): string {
    if (symbol.flags & ts.SymbolFlags.Module) return sha('namespace');
    this.root = symbol;
    const parts: string[] = [];
    if (symbol.flags & ts.SymbolFlags.Value) {
      parts.push(`value ${this.shape(this.checker.getTypeOfSymbol(symbol), 0).text}`);
    }
    if (symbol.flags & ts.SymbolFlags.Type) {
      const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
      const typeParameters =
        (declared as ts.InterfaceType).typeParameters ?? declared.aliasTypeArguments ?? [];
      parts.push(
        `type <${typeParameters.map((parameter) => this.typeParameter(parameter, 0)).join(',')}> ${this.shape(declared, 0).text}`
      );
    }
    this.root = undefined;
    return sha(parts.join('\n'));
  }

  private typeParameter(parameter: ts.Type, depth: number): string {
    const constraint = parameter.getConstraint();
    const fallback = parameter.getDefault();
    return (
      `${parameter.symbol?.name ?? '?'}` +
      (constraint ? ` extends ${this.shape(constraint, depth).text}` : '') +
      (fallback ? ` = ${this.shape(fallback, depth).text}` : '')
    );
  }

  private symbolOf(type: ts.Type): ts.Symbol | undefined {
    if (type.aliasSymbol) return type.aliasSymbol;
    if (getObjectFlags(type) & ts.ObjectFlags.Reference) {
      return (type as ts.TypeReference).target.symbol;
    }
    return type.symbol;
  }

  private typeArguments(type: ts.Type): readonly ts.Type[] {
    if (type.aliasSymbol) return type.aliasTypeArguments ?? [];
    if (getObjectFlags(type) & ts.ObjectFlags.Reference) {
      return this.checker.getTypeArguments(type as ts.TypeReference);
    }
    return [];
  }

  private isExternal(symbol: ts.Symbol): boolean {
    const declarations = symbol.declarations ?? [];
    return (
      declarations.length > 0 &&
      declarations.every(
        (declaration) => !this.options.isPackageFile(declaration.getSourceFile().fileName)
      )
    );
  }

  /** The shape of a type as it appears inside another type. */
  private shape(type: ts.Type, depth: number): Shape {
    const flags = type.flags;
    const leaf = (text: string): Shape => ({ text, cyclic: false });

    if (flags & ts.TypeFlags.TypeParameter) {
      return leaf(
        (type as { isThisType?: boolean }).isThisType ? 'this' : `T:${type.symbol?.name}`
      );
    }
    if (flags & ts.TypeFlags.StringLiteral)
      return leaf(JSON.stringify((type as ts.StringLiteralType).value));
    if (flags & ts.TypeFlags.NumberLiteral) return leaf(`${(type as ts.NumberLiteralType).value}`);
    if (flags & ts.TypeFlags.BigIntLiteral) {
      const value = (type as ts.BigIntLiteralType).value;
      return leaf(`${value.negative ? '-' : ''}${value.base10Value}n`);
    }
    if (
      flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.String |
        ts.TypeFlags.Number |
        ts.TypeFlags.BigInt |
        ts.TypeFlags.Boolean |
        ts.TypeFlags.BooleanLiteral |
        ts.TypeFlags.ESSymbol |
        ts.TypeFlags.Void |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Null |
        ts.TypeFlags.Never |
        ts.TypeFlags.NonPrimitive)
    ) {
      return leaf(this.checker.typeToString(type));
    }
    if (flags & ts.TypeFlags.UniqueESSymbol) {
      const symbol = type.symbol;
      return leaf(
        `unique symbol ${symbol ? (this.options.publicNames.get(symbol) ?? symbol.name) : ''}`
      );
    }

    // Named references that have their own line, or live outside the package.
    const symbol = this.symbolOf(type);
    // The symbol being hashed is expanded at the top; deeper self-references use its name.
    const isRoot = symbol === this.root && depth === 0;
    if (symbol && !isRoot && !(symbol.flags & ts.SymbolFlags.TypeParameter)) {
      const publicName = this.options.publicNames.get(symbol);
      const external =
        publicName === undefined && this.isExternal(symbol)
          ? `ext(${this.options.externalModuleName(symbol.declarations?.[0]?.getSourceFile().fileName ?? '')}:${symbol.name})`
          : undefined;
      const reference = publicName === undefined ? external : `pub(${publicName})`;
      if (reference !== undefined) {
        const args = this.typeArguments(type).map((argument) => this.shape(argument, depth + 1));
        return {
          text:
            args.length > 0 ? `${reference}<${args.map((arg) => arg.text).join(',')}>` : reference,
          cyclic: args.some((arg) => arg.cyclic),
        };
      }
    }

    return this.expand(type, depth);
  }

  /** Expands a composite type structurally, with cycle and depth guards. */
  private expand(type: ts.Type, depth: number): Shape {
    const onStack = this.stack.indexOf(type);
    if (onStack >= 0) return { text: `^${this.stack.length - onStack}`, cyclic: true };
    const memoized = this.memo.get(type);
    if (memoized !== undefined) return { text: memoized, cyclic: false };
    if (depth > MAX_DEPTH) return { text: '…', cyclic: true };

    this.stack.push(type);
    let cyclic = false;
    const child = (inner: ts.Type): string => {
      const result = this.shape(inner, depth + 1);
      cyclic ||= result.cyclic;
      return result.text;
    };
    let text: string;
    try {
      text = this.structure(type, child, depth);
    } finally {
      this.stack.pop();
    }

    const compact = text.length > 64 ? `#${sha(text)}` : text;
    if (!cyclic) this.memo.set(type, compact);
    return { text: compact, cyclic };
  }

  private structure(type: ts.Type, child: (inner: ts.Type) => string, depth: number): string {
    const checker = this.checker;
    const flags = type.flags;

    if (flags & ts.TypeFlags.Union) {
      return `(${(type as ts.UnionType).types.map(child).sort(compareText).join('|')})`;
    }
    if (flags & ts.TypeFlags.Intersection) {
      return `(${(type as ts.IntersectionType).types.map(child).sort(compareText).join('&')})`;
    }
    if (flags & ts.TypeFlags.TemplateLiteral) {
      const template = type as ts.TemplateLiteralType;
      return `\`${template.texts.map((text, index) => `${JSON.stringify(text)}${template.types[index] ? `\${${child(template.types[index] as ts.Type)}}` : ''}`).join('')}\``;
    }
    if (flags & ts.TypeFlags.StringMapping) {
      const mapping = type as ts.StringMappingType;
      return `${mapping.symbol.name}<${child(mapping.type)}>`;
    }
    if (flags & ts.TypeFlags.Index) return `keyof ${child((type as ts.IndexType).type)}`;
    if (flags & ts.TypeFlags.IndexedAccess) {
      const access = type as ts.IndexedAccessType;
      return `${child(access.objectType)}[${child(access.indexType)}]`;
    }
    if (flags & ts.TypeFlags.Conditional) {
      const conditional = type as ts.ConditionalType;
      const node = conditional.root.node;
      return `(${child(conditional.checkType)} extends ${child(conditional.extendsType)} ? ${child(checker.getTypeFromTypeNode(node.trueType))} : ${child(checker.getTypeFromTypeNode(node.falseType))})`;
    }
    if (flags & ts.TypeFlags.Substitution) {
      return child((type as ts.SubstitutionType).baseType);
    }
    if (!(flags & ts.TypeFlags.Object)) {
      return `?${ts.TypeFlags[flags] ?? flags}`;
    }

    const objectFlags = getObjectFlags(type);
    const mappedNode = type.symbol?.declarations?.[0];
    if (objectFlags & ts.ObjectFlags.Mapped && mappedNode && ts.isMappedTypeNode(mappedNode)) {
      const constraint = mappedNode.typeParameter.constraint;
      return (
        `{${mappedNode.readonlyToken ? `${mappedNode.readonlyToken.getText()}readonly ` : ''}` +
        `[${mappedNode.typeParameter.name.text} in ${constraint ? child(checker.getTypeFromTypeNode(constraint)) : '?'}` +
        `${mappedNode.nameType ? ` as ${child(checker.getTypeFromTypeNode(mappedNode.nameType))}` : ''}]` +
        `${mappedNode.questionToken ? `${mappedNode.questionToken.getText()}?` : ''}: ` +
        `${mappedNode.type ? child(checker.getTypeFromTypeNode(mappedNode.type)) : 'any'}}`
      );
    }
    if (
      objectFlags & ts.ObjectFlags.Reference &&
      (type as ts.TypeReference).target.objectFlags & ts.ObjectFlags.Tuple
    ) {
      const tuple = (type as ts.TypeReference).target as ts.TupleType;
      const args = checker.getTypeArguments(type as ts.TypeReference);
      return `${tuple.readonly ? 'readonly ' : ''}[${args
        .map((argument, index) => {
          const elementFlags = tuple.elementFlags[index] ?? ts.ElementFlags.Required;
          const prefix = elementFlags & ts.ElementFlags.Variable ? '...' : '';
          const suffix = elementFlags & ts.ElementFlags.Optional ? '?' : '';
          return `${prefix}${child(argument)}${suffix}`;
        })
        .join(',')}]`;
    }

    const parts: string[] = [];
    // Type arguments of a non-exported generic reference (for example Hidden<string>)
    // are already applied to its members, so the members below cover them.
    for (const property of [...checker.getPropertiesOfType(type)].sort((a, b) =>
      compareText(a.name, b.name)
    )) {
      const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
      const readonly = (property.declarations ?? []).some(
        (declaration) => ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly
      )
        ? 'readonly '
        : '';
      const method = property.flags & ts.SymbolFlags.Method ? 'method ' : '';
      parts.push(
        `${readonly}${method}${property.name}${optional}:${child(checker.getTypeOfSymbol(property))}`
      );
    }
    for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      parts.push(`call ${this.signature(signature, child, depth)}`);
    }
    for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)) {
      parts.push(`new ${this.signature(signature, child, depth)}`);
    }
    for (const info of checker.getIndexInfosOfType(type)) {
      parts.push(
        `${info.isReadonly ? 'readonly ' : ''}[${child(info.keyType)}]:${child(info.type)}`
      );
    }
    return `{${parts.join(';')}}`;
  }

  private signature(
    signature: ts.Signature,
    child: (inner: ts.Type) => string,
    depth: number
  ): string {
    const checker = this.checker;
    const typeParameters = (signature.getTypeParameters() ?? []).map((parameter) =>
      this.typeParameter(parameter, depth + 1)
    );
    const thisParameter = (signature as { thisParameter?: ts.Symbol }).thisParameter;
    const parameters = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration;
      const isParameter = declaration !== undefined && ts.isParameter(declaration);
      const rest = isParameter && declaration.dotDotDotToken ? '...' : '';
      const optional = isParameter && checker.isOptionalParameter(declaration) ? '?' : '';
      return `${rest}${optional}${child(checker.getTypeOfSymbol(parameter))}`;
    });
    if (thisParameter) parameters.unshift(`this:${child(checker.getTypeOfSymbol(thisParameter))}`);
    const predicate = checker.getTypePredicateOfSignature(signature);
    const returns = predicate
      ? `${predicate.kind === ts.TypePredicateKind.AssertsThis || predicate.kind === ts.TypePredicateKind.AssertsIdentifier ? 'asserts ' : ''}${predicate.parameterIndex ?? 'this'} is ${predicate.type ? child(predicate.type) : ''}`
      : child(checker.getReturnTypeOfSignature(signature));
    return `<${typeParameters.join(',')}>(${parameters.join(',')})=>${returns}`;
  }
}

function getObjectFlags(type: ts.Type): ts.ObjectFlags {
  return type.flags & ts.TypeFlags.Object ? (type as ts.ObjectType).objectFlags : 0;
}
