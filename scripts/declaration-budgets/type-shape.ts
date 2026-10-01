/**
 * Structural type-shape hashing for the public API snapshot.
 *
 * A symbol's hash covers the structure of every type its declaration depends
 * on, recursively:
 *
 * - Public exports (symbols with their own snapshot line) are referenced by
 *   their public name plus type arguments; their own line covers their shape.
 * - Types from dependencies and the TypeScript lib are referenced by module
 *   path and name, plus type arguments.
 * - An instantiation of a non-exported generic type alias is written as the
 *   alias body (expanded once, generically) plus its hashed type arguments, so
 *   `Alias<A>` and `Alias<B>` differ even when A and B are structurally equal
 *   public types.
 * - Everything else is expanded: non-exported interfaces, classes and enums,
 *   anonymous object and function types, unions, intersections, tuples,
 *   mapped, conditional, indexed-access and template literal types. Mapped and
 *   conditional types use the checker's instantiated template, constraint and
 *   branch types. Members carry their modifiers (optional, readonly,
 *   public/protected/private, abstract, accessor shape); signatures carry type
 *   parameters, parameters, `this`, return types and type predicates; classes
 *   carry abstractness and constructor visibility; enum literals carry their
 *   enum's identity, member name and value.
 *
 * Non-exported types are expanded by structure; their names are not hashed.
 * Consumers cannot refer to a non-exported type by name, so renaming one
 * without changing its structure leaves every hash unchanged.
 *
 * Termination and order independence: a type already on the expansion stack is
 * written as a relative back-reference (`^n`), and expansion stops at
 * MAX_DEPTH. Only acyclic, uncut expansions are memoized, together with their
 * height, and a memoized expansion is reused only where it fits under the
 * depth cap. Every expansion therefore depends only on the type and the path to
 * it, never on which symbols or members were visited first. Property keys that
 * are unique symbols or private names are named by their declaration, never by
 * TypeScript's internal symbol ids.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { compareText } from './graph.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Expansion depth cap; guards generics that expand forever (for example `Deep<T[]>`). */
export const MAX_DEPTH = 64;

interface Shape {
  text: string;
  /** Contains a back-reference or a depth cut, so it depends on the path to it. */
  cyclic: boolean;
  /** Height of the expansion tree, for reusing memoized shapes under the depth cap. */
  height: number;
}

type Child = (inner: ts.Type) => string;

export interface TypeShapeHasherOptions {
  checker: ts.TypeChecker;
  /** Public symbol (alias-resolved) to the name its snapshot line uses. */
  publicNames: ReadonlyMap<ts.Symbol, string>;
  /** Whether a source file belongs to the package (as opposed to a dependency or the lib). */
  isPackageFile: (fileName: string) => boolean;
  /** Makes a dependency file name location-independent. */
  externalModuleName: (fileName: string) => string;
}

const VALUE_FLAGS = ts.SymbolFlags.Value & ~ts.SymbolFlags.ValueModule;
const NAMESPACE_FLAGS = ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule;

/**
 * The hasher reads a few TypeScript internals that have no public API (see the
 * README). When one is missing, stop with a clear error rather than silently
 * hashing less.
 */
export function missingTypeScriptInternal(field: string): Error {
  return new Error(
    `The public API snapshot relies on TypeScript's internal ${field}, which TypeScript ` +
      `${ts.version} does not provide. Update scripts/declaration-budgets/type-shape.ts.`
  );
}

/** Internal TypeScript helper: check flags of transient (for example mapped) property symbols. */
const getCheckFlags = (ts as unknown as { getCheckFlags?: (symbol: ts.Symbol) => number })
  .getCheckFlags;
/** `ts.CheckFlags.Readonly`. */
const CHECK_FLAGS_READONLY = 8;

/**
 * The kinds a symbol exposes, for the snapshot's kind column. A type-only
 * export exposes only a type (for a value, only `typeof`), so it is `type`.
 */
export function symbolKinds(symbol: ts.Symbol, typeOnly: boolean): string {
  const kinds: string[] = [];
  if (typeOnly) {
    if (symbol.flags & (VALUE_FLAGS | ts.SymbolFlags.Type)) kinds.push('type');
  } else {
    if (symbol.flags & VALUE_FLAGS) kinds.push('value');
    if (symbol.flags & ts.SymbolFlags.Type) kinds.push('type');
  }
  if (symbol.flags & NAMESPACE_FLAGS) kinds.push('namespace');
  return kinds.length > 0 ? kinds.join('+') : 'unresolved';
}

export class TypeShapeHasher {
  private readonly checker: ts.TypeChecker;
  private readonly memo = new Map<ts.Type, { text: string; height: number }>();
  private readonly stack: ts.Type[] = [];
  private root: ts.Symbol | undefined;

  constructor(private readonly options: TypeShapeHasherOptions) {
    this.checker = options.checker;
    if (typeof getCheckFlags !== 'function') throw missingTypeScriptInternal('ts.getCheckFlags');
  }

  /**
   * Hash of everything a symbol exposes: its value type, its declared type
   * (with type parameters and, for classes, abstractness) and whether it is a
   * namespace. A type-only export exposes its value type only through `typeof`,
   * which is marked in the hash.
   */
  hashSymbol(symbol: ts.Symbol, typeOnly = false): string {
    this.root = symbol;
    const parts: string[] = [symbolKinds(symbol, typeOnly)];
    if (symbol.flags & VALUE_FLAGS) {
      // A type-only export can still be used as `typeof X`, so its value type counts.
      parts.push(
        `${typeOnly ? 'typeof-only' : 'value'} ${this.shape(this.checker.getTypeOfSymbol(symbol), 0).text}`
      );
    }
    if (symbol.flags & ts.SymbolFlags.Type) {
      const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
      const typeParameters =
        (declared as ts.InterfaceType).typeParameters ?? declared.aliasTypeArguments ?? [];
      const abstract =
        symbol.flags & ts.SymbolFlags.Class && this.isAbstractClass(symbol) ? 'abstract ' : '';
      parts.push(
        `type ${abstract}<${typeParameters.map((parameter) => this.typeParameter(parameter, 0)).join(',')}> ${this.shape(declared, 0).text}`
      );
    }
    this.root = undefined;
    return sha(parts.join('\n'));
  }

  private isAbstractClass(symbol: ts.Symbol | undefined): boolean {
    return (symbol?.declarations ?? []).some(
      (declaration) =>
        ts.isClassLike(declaration) &&
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Abstract) !== 0
    );
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

  /** `pub(name)` or `ext(module:name)` for symbols that are not expanded; undefined otherwise. */
  private referenceName(symbol: ts.Symbol): string | undefined {
    const publicName = this.options.publicNames.get(symbol);
    if (publicName !== undefined) return `pub(${publicName})`;
    if (this.isExternal(symbol)) {
      const file = symbol.declarations?.[0]?.getSourceFile().fileName ?? '';
      return `ext(${this.options.externalModuleName(file)}:${symbol.name})`;
    }
    return undefined;
  }

  /** Stable name for a property key: unique-symbol and private keys by declaration, not symbol id. */
  private propertyName(property: ts.Symbol): string {
    const name = property.name;
    if (name.startsWith('__#')) return name.replace(/^__#\d+@/, '');
    if (!name.startsWith('__@')) return name;
    const links = (property as { links?: { nameType?: ts.Type } }).links;
    if (property.flags & ts.SymbolFlags.Transient && links === undefined) {
      throw missingTypeScriptInternal('Symbol.links (for the key of a symbol-keyed property)');
    }
    const nameType = links?.nameType;
    let keySymbol =
      nameType && nameType.flags & ts.TypeFlags.UniqueESSymbol ? nameType.symbol : undefined;
    if (!keySymbol) {
      for (const declaration of property.declarations ?? []) {
        const nameNode = ts.getNameOfDeclaration(declaration);
        if (nameNode && ts.isComputedPropertyName(nameNode)) {
          keySymbol = this.checker.getSymbolAtLocation(nameNode.expression);
          if (keySymbol) break;
        }
      }
    }
    if (keySymbol) {
      const resolved =
        keySymbol.flags & ts.SymbolFlags.Alias
          ? this.checker.getAliasedSymbol(keySymbol)
          : keySymbol;
      return `[${this.referenceName(resolved) ?? `symbol ${resolved.name}`}]`;
    }
    return `[${name.replace(/^__@/, '').replace(/@\d+$/, '')}]`;
  }

  private enumLiteral(type: ts.Type): string {
    const member = type.symbol;
    const value =
      type.flags & ts.TypeFlags.StringLiteral
        ? JSON.stringify((type as ts.StringLiteralType).value)
        : `${(type as ts.NumberLiteralType).value}`;
    const declaration = member?.valueDeclaration;
    if (!member || !declaration || !ts.isEnumMember(declaration)) return `enum?=${value}`;
    const enumDeclaration = declaration.parent;
    const enumSymbol = this.checker.getSymbolAtLocation(enumDeclaration.name);
    const identity =
      (enumSymbol && this.referenceName(enumSymbol)) ??
      `enum{${enumDeclaration.members
        .map(
          (item) =>
            `${item.name.getText()}=${JSON.stringify(this.checker.getConstantValue(item) ?? null)}`
        )
        .join(',')}}`;
    return `${identity}.${declaration.name.getText()}=${value}`;
  }

  /** The shape of a type as it appears inside another type. */
  private shape(type: ts.Type, depth: number): Shape {
    const flags = type.flags;
    const leaf = (text: string): Shape => ({ text, cyclic: false, height: 0 });

    if (flags & ts.TypeFlags.TypeParameter) {
      return leaf(
        (type as { isThisType?: boolean }).isThisType ? 'this' : `T:${type.symbol?.name}`
      );
    }
    if (
      flags & ts.TypeFlags.EnumLiteral &&
      flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral)
    ) {
      return leaf(this.enumLiteral(type));
    }
    if (flags & ts.TypeFlags.StringLiteral) {
      return leaf(JSON.stringify((type as ts.StringLiteralType).value));
    }
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
      return leaf(`unique symbol ${symbol ? (this.referenceName(symbol) ?? symbol.name) : ''}`);
    }

    const symbol = this.symbolOf(type);
    // The symbol being hashed is expanded at the top; deeper self-references use its name.
    const isRoot = symbol === this.root && depth === 0;
    if (symbol && !isRoot && !(symbol.flags & ts.SymbolFlags.TypeParameter)) {
      const reference = this.referenceName(symbol);
      if (reference !== undefined) {
        // `typeof C` (a class's constructor, an enum object, a function) is not `C`.
        const valueSide =
          !type.aliasSymbol &&
          symbol.flags & ts.SymbolFlags.Value &&
          this.checker.getTypeOfSymbol(symbol) === type;
        return this.withArguments(valueSide ? `typeof ${reference}` : reference, type, depth);
      }

      // A non-exported generic alias instantiation: the alias body once, plus arguments.
      const aliasArguments = type.aliasSymbol ? (type.aliasTypeArguments ?? []) : [];
      if (type.aliasSymbol && aliasArguments.length > 0) {
        const declared = this.checker.getDeclaredTypeOfSymbol(type.aliasSymbol);
        if (declared !== type) {
          const body = this.expand(declared, depth + 1);
          const parameters = (declared.aliasTypeArguments ?? []).map(
            (parameter) => parameter.symbol?.name ?? '?'
          );
          const args = aliasArguments.map((argument) => this.shape(argument, depth + 1));
          return {
            text: `alias<${parameters.join(',')}>${body.text}<${args.map((arg) => arg.text).join(',')}>`,
            cyclic: body.cyclic || args.some((arg) => arg.cyclic),
            height: 1 + Math.max(body.height, ...args.map((arg) => arg.height)),
          };
        }
      }
    }

    return this.expand(type, depth);
  }

  private withArguments(reference: string, type: ts.Type, depth: number): Shape {
    const args = this.typeArguments(type).map((argument) => this.shape(argument, depth + 1));
    return {
      text: args.length > 0 ? `${reference}<${args.map((arg) => arg.text).join(',')}>` : reference,
      cyclic: args.some((arg) => arg.cyclic),
      height: args.length > 0 ? 1 + Math.max(...args.map((arg) => arg.height)) : 0,
    };
  }

  /** Expands a composite type structurally, with cycle and depth guards. */
  private expand(type: ts.Type, depth: number): Shape {
    const onStack = this.stack.indexOf(type);
    if (onStack >= 0) return { text: `^${this.stack.length - onStack}`, cyclic: true, height: 0 };
    const memoized = this.memo.get(type);
    // A memoized expansion is reused only where a fresh one would not be cut either.
    if (memoized !== undefined && depth + memoized.height <= MAX_DEPTH) {
      return { text: memoized.text, cyclic: false, height: memoized.height };
    }
    if (depth > MAX_DEPTH) return { text: '…', cyclic: true, height: 0 };

    this.stack.push(type);
    let cyclic = false;
    let height = 0;
    const child: Child = (inner) => {
      const result = this.shape(inner, depth + 1);
      cyclic ||= result.cyclic;
      height = Math.max(height, result.height + 1);
      return result.text;
    };
    let text: string;
    try {
      text = this.structure(type, child);
    } finally {
      this.stack.pop();
    }

    const compact = text.length > 64 ? `#${sha(text)}` : text;
    if (!cyclic && !this.memo.has(type)) this.memo.set(type, { text: compact, height });
    return { text: compact, cyclic, height };
  }

  /**
   * Makes the checker compute and cache the instantiated parts of a mapped or
   * conditional type, by building its type node. Returns that node.
   */
  private buildNode(type: ts.Type): ts.TypeNode | undefined {
    return this.checker.typeToTypeNode(
      type,
      undefined,
      ts.NodeBuilderFlags.InTypeAlias |
        ts.NodeBuilderFlags.NoTruncation |
        ts.NodeBuilderFlags.IgnoreErrors
    );
  }

  private structure(type: ts.Type, child: Child): string {
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
      const conditional = type as ts.ConditionalType & {
        resolvedTrueType?: ts.Type;
        resolvedFalseType?: ts.Type;
      };
      this.buildNode(type);
      const whenTrue = conditional.resolvedTrueType;
      const whenFalse = conditional.resolvedFalseType;
      if (!whenTrue) throw missingTypeScriptInternal('ConditionalType.resolvedTrueType');
      if (!whenFalse) throw missingTypeScriptInternal('ConditionalType.resolvedFalseType');
      return `(${conditional.root.isDistributive ? 'distributive ' : ''}${child(conditional.checkType)} extends ${child(conditional.extendsType)} ? ${child(whenTrue)} : ${child(whenFalse)})`;
    }
    if (flags & ts.TypeFlags.Substitution) {
      return child((type as ts.SubstitutionType).baseType);
    }
    if (!(flags & ts.TypeFlags.Object)) {
      return `?${ts.TypeFlags[flags] ?? flags}`;
    }

    const objectFlags = getObjectFlags(type);
    if (objectFlags & ts.ObjectFlags.Mapped) {
      const mapped = type as ts.ObjectType & {
        declaration?: ts.MappedTypeNode;
        typeParameter?: ts.TypeParameter;
        templateType?: ts.Type;
        nameType?: ts.Type;
        modifiersType?: ts.Type;
      };
      // The node builder takes the mapped path only for generic mapped types; it
      // then caches the instantiated parameter, template, name and modifiers types.
      // Non-generic mapped types resolve to plain members, expanded below.
      const node = this.buildNode(type);
      const declaration = mapped.declaration;
      if (!declaration) throw missingTypeScriptInternal('MappedType.declaration');
      if (node && ts.isMappedTypeNode(node)) {
        const typeParameter = mapped.typeParameter;
        const template = mapped.templateType;
        if (!typeParameter) throw missingTypeScriptInternal('MappedType.typeParameter');
        if (!template) throw missingTypeScriptInternal('MappedType.templateType');
        const constraintNode = declaration.typeParameter.constraint;
        const keyofConstraint =
          constraintNode !== undefined &&
          ts.isTypeOperatorNode(constraintNode) &&
          constraintNode.operator === ts.SyntaxKind.KeyOfKeyword;
        if (keyofConstraint && !mapped.modifiersType) {
          throw missingTypeScriptInternal('MappedType.modifiersType');
        }
        if (declaration.nameType && !mapped.nameType) {
          throw missingTypeScriptInternal('MappedType.nameType');
        }
        const constraintType = typeParameter.getConstraint();
        const constraint =
          keyofConstraint && mapped.modifiersType
            ? `keyof ${child(mapped.modifiersType)}`
            : constraintType
              ? child(constraintType)
              : '?';
        const token = (value: ts.Node | undefined, text: string) =>
          value ? `${value.kind === ts.SyntaxKind.MinusToken ? '-' : '+'}${text}` : '';
        return (
          `{${token(declaration.readonlyToken, 'readonly ')}` +
          `[${typeParameter.symbol?.name} in ${constraint}` +
          `${declaration.nameType && mapped.nameType ? ` as ${child(mapped.nameType)}` : ''}]` +
          `${token(declaration.questionToken, '?')}: ${child(template)}}`
        );
      }
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
    const properties = checker
      .getPropertiesOfType(type)
      .map((property) => [this.propertyName(property), property] as const)
      .sort(([a], [b]) => compareText(a, b));
    for (const [name, property] of properties) {
      parts.push(this.member(name, property, child));
    }
    for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      parts.push(`call ${this.signature(signature, child)}`);
    }
    const construct = checker.getSignaturesOfType(type, ts.SignatureKind.Construct);
    const abstract = construct.length > 0 && this.isAbstractClass(type.symbol) ? 'abstract ' : '';
    for (const signature of construct) {
      const declaration = signature.declaration;
      const modifiers =
        declaration && ts.isConstructorDeclaration(declaration)
          ? ts.getCombinedModifierFlags(declaration)
          : ts.ModifierFlags.None;
      parts.push(`${abstract}${visibility(modifiers)}new ${this.signature(signature, child)}`);
    }
    for (const info of checker.getIndexInfosOfType(type)) {
      parts.push(
        `${info.isReadonly ? 'readonly ' : ''}[${child(info.keyType)}]:${child(info.type)}`
      );
    }
    return `{${parts.join(';')}}`;
  }

  private member(name: string, property: ts.Symbol, child: Child): string {
    const declarations = property.declarations ?? [];
    const modifiers = declarations.reduce(
      (all, declaration) => all | ts.getCombinedModifierFlags(declaration as ts.Declaration),
      ts.ModifierFlags.None
    );
    const readonly =
      modifiers & ts.ModifierFlags.Readonly ||
      (getCheckFlags?.(property) ?? 0) & CHECK_FLAGS_READONLY
        ? 'readonly '
        : '';
    const optional = property.flags & ts.SymbolFlags.Optional ? '?' : '';
    const abstract = modifiers & ts.ModifierFlags.Abstract ? 'abstract ' : '';
    const method = property.flags & ts.SymbolFlags.Method ? 'method ' : '';
    let accessor = '';
    if (property.flags & ts.SymbolFlags.Accessor) {
      const setter = declarations.find(ts.isSetAccessorDeclaration);
      const setterType = setter?.parameters[0]?.type;
      accessor =
        `${property.flags & ts.SymbolFlags.GetAccessor ? 'get ' : ''}` +
        `${property.flags & ts.SymbolFlags.SetAccessor ? `set(${setterType ? child(this.checker.getTypeFromTypeNode(setterType)) : ''}) ` : ''}`;
    }
    return `${visibility(modifiers)}${abstract}${readonly}${method}${accessor}${name}${optional}:${child(this.checker.getTypeOfSymbol(property))}`;
  }

  private signature(signature: ts.Signature, child: Child): string {
    const checker = this.checker;
    const typeParameters = (signature.getTypeParameters() ?? []).map((parameter) => {
      const constraint = parameter.getConstraint();
      const fallback = parameter.getDefault();
      return (
        `${parameter.symbol?.name ?? '?'}` +
        (constraint ? ` extends ${child(constraint)}` : '') +
        (fallback ? ` = ${child(fallback)}` : '')
      );
    });
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

function visibility(modifiers: ts.ModifierFlags): string {
  if (modifiers & ts.ModifierFlags.Private) return 'private ';
  if (modifiers & ts.ModifierFlags.Protected) return 'protected ';
  return '';
}

function getObjectFlags(type: ts.Type): ts.ObjectFlags {
  return type.flags & ts.TypeFlags.Object ? (type as ts.ObjectType).objectFlags : 0;
}
