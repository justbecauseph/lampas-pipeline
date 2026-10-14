/**
 * Fabric Loader version and version-predicate semantics, ported from
 * net.fabricmc.loader.impl.util.version (SemanticVersionImpl, StringVersion, VersionParser,
 * VersionPredicateParser) and net.fabricmc.loader.api.metadata.version.VersionComparisonOperator.
 */

/** SemanticVersion.COMPONENT_WILDCARD (Integer.MIN_VALUE). */
const COMPONENT_WILDCARD = -2147483648;
const INT_MAX = 2147483647;
const DOT_SEPARATED_ID = /^(?:|[-0-9A-Za-z]+(?:\.[-0-9A-Za-z]+)*)$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;

export interface SemanticVersion {
  kind: "semantic";
  components: number[];
  prerelease: string | null;
  build: string | null;
  friendly: string;
}

export interface StringVersion {
  kind: "string";
  friendly: string;
}

export type FabricVersion = SemanticVersion | StringVersion;

export class VersionParsingError extends Error {}

function friendlyName(components: number[], prerelease: string | null, build: string | null): string {
  let name = components.map((c) => (c === COMPONENT_WILDCARD ? "x" : String(c))).join(".");
  if (prerelease !== null) name += `-${prerelease}`;
  if (build !== null) name += `+${build}`;
  return name;
}

function semantic(components: number[], prerelease: string | null, build: string | null): SemanticVersion {
  return { kind: "semantic", components, prerelease, build, friendly: friendlyName(components, prerelease, build) };
}

/** Java Integer.parseInt for the component strings SemanticVersionImpl can reach. */
function parseIntComponent(compStr: string): number {
  if (!/^[+-]?[0-9]+$/.test(compStr)) {
    throw new VersionParsingError(`Could not parse version number component '${compStr}'!`);
  }
  const value = Number(compStr);
  if (!Number.isSafeInteger(value) || value > INT_MAX || value < COMPONENT_WILDCARD) {
    throw new VersionParsingError(`Could not parse version number component '${compStr}'!`);
  }
  return value;
}

/** SemanticVersionImpl(String, boolean). Throws VersionParsingError where Fabric throws. */
export function parseSemanticVersion(input: string, storeX: boolean): SemanticVersion {
  let version = input;
  let build: string | null = null;
  let prerelease: string | null = null;

  const buildDelimPos = version.indexOf("+");
  if (buildDelimPos >= 0) {
    build = version.substring(buildDelimPos + 1);
    version = version.substring(0, buildDelimPos);
  }

  const dashDelimPos = version.indexOf("-");
  if (dashDelimPos >= 0) {
    prerelease = version.substring(dashDelimPos + 1);
    version = version.substring(0, dashDelimPos);
  }

  if (prerelease !== null && !DOT_SEPARATED_ID.test(prerelease)) {
    throw new VersionParsingError(`Invalid prerelease string '${prerelease}'!`);
  }
  if (version.endsWith(".")) {
    throw new VersionParsingError("Negative version number component found!");
  } else if (version.startsWith(".")) {
    throw new VersionParsingError("Missing version component!");
  }

  const componentStrings = version.split(".");
  let components: number[] = new Array(componentStrings.length);
  let firstWildcardIdx = -1;

  for (let i = 0; i < componentStrings.length; i++) {
    const compStr = componentStrings[i];

    if (storeX) {
      if (compStr === "x" || compStr === "X" || compStr === "*") {
        if (prerelease !== null) {
          throw new VersionParsingError("Pre-release versions are not allowed to use X-ranges!");
        }
        components[i] = COMPONENT_WILDCARD;
        if (firstWildcardIdx < 0) firstWildcardIdx = i;
        continue;
      } else if (i > 0 && components[i - 1] === COMPONENT_WILDCARD) {
        throw new VersionParsingError("Interjacent wildcard (1.x.2) are disallowed!");
      }
    }

    if (compStr.trim().length === 0) {
      throw new VersionParsingError("Missing version number component!");
    }
    components[i] = parseIntComponent(compStr);
    if (components[i] < 0) {
      throw new VersionParsingError(`Negative version number component '${compStr}'!`);
    }
  }

  if (storeX && components.length === 1 && components[0] === COMPONENT_WILDCARD) {
    throw new VersionParsingError("Versions of form 'x' or 'X' not allowed!");
  }

  // strip extra wildcards (1.x.x -> 1.x)
  if (firstWildcardIdx > 0 && components.length > firstWildcardIdx + 1) {
    components = components.slice(0, firstWildcardIdx + 1);
  }

  // SemanticVersionImpl does not validate the build key.
  return semantic(components, prerelease, build);
}

/** VersionParser.parse: semantic when possible, otherwise a StringVersion. */
export function parseVersion(input: string, storeX = false): FabricVersion {
  if (input.length === 0) {
    throw new VersionParsingError("Version must be a non-empty string!");
  }
  try {
    return parseSemanticVersion(input, storeX);
  } catch (err) {
    if (err instanceof VersionParsingError) return { kind: "string", friendly: input };
    throw err;
  }
}

function component(v: SemanticVersion, pos: number): number {
  if (pos >= v.components.length) {
    // Repeat "x" if x-range, otherwise repeat "0".
    return v.components[v.components.length - 1] === COMPONENT_WILDCARD ? COMPONENT_WILDCARD : 0;
  }
  return v.components[pos];
}

function hasWildcard(v: SemanticVersion): boolean {
  return v.components.some((c) => c < 0);
}

/** Java String.compareTo (UTF-16 code units), reduced to its sign. */
function compareJavaStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSemantic(a: SemanticVersion, b: SemanticVersion): number {
  const count = Math.max(a.components.length, b.components.length);
  for (let i = 0; i < count; i++) {
    const first = component(a, i);
    const second = component(b, i);
    if (first === COMPONENT_WILDCARD || second === COMPONENT_WILDCARD) continue;
    if (first !== second) return first < second ? -1 : 1;
  }

  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease !== null && b.prerelease !== null) {
    // StringTokenizer skips empty tokens.
    const partsA = a.prerelease.split(".").filter((p) => p.length > 0);
    const partsB = b.prerelease.split(".").filter((p) => p.length > 0);
    for (let i = 0; i < partsA.length; i++) {
      if (i >= partsB.length) return 1;
      const partA = partsA[i];
      const partB = partsB[i];
      if (UNSIGNED_INTEGER.test(partA)) {
        if (UNSIGNED_INTEGER.test(partB)) {
          if (partA.length !== partB.length) return partA.length < partB.length ? -1 : 1;
        } else {
          return -1;
        }
      } else if (UNSIGNED_INTEGER.test(partB)) {
        return 1;
      }
      const compare = compareJavaStrings(partA, partB);
      if (compare !== 0) return compare;
    }
    return partsB.length > partsA.length ? -1 : 0;
  }
  if (a.prerelease !== null) return hasWildcard(b) ? 0 : -1;
  return hasWildcard(a) ? 0 : 1;
}

/** Version.compareTo. A StringVersion on either side compares friendly strings. */
export function compareVersions(a: FabricVersion, b: FabricVersion): number {
  if (a.kind === "semantic" && b.kind === "semantic") return compareSemantic(a, b);
  return compareJavaStrings(a.friendly, b.friendly);
}

type Operator = ">=" | "<=" | ">" | "<" | "=" | "~" | "^";

// Order matters: the longest operator must match first (>= before >).
const OPERATORS: ReadonlyArray<{ op: Operator; minInclusive: boolean; maxInclusive: boolean }> = [
  { op: ">=", minInclusive: true, maxInclusive: false },
  { op: "<=", minInclusive: false, maxInclusive: true },
  { op: ">", minInclusive: false, maxInclusive: false },
  { op: "<", minInclusive: false, maxInclusive: false },
  { op: "=", minInclusive: true, maxInclusive: true },
  { op: "~", minInclusive: true, maxInclusive: false },
  { op: "^", minInclusive: true, maxInclusive: false },
];

interface PredicateTerm {
  op: Operator;
  version: FabricVersion;
}

/** A parsed predicate string: its terms are ANDed. No terms means any version. */
export interface VersionPredicate {
  source: string;
  terms: PredicateTerm[];
}

/** VersionPredicateParser.parse. */
export function parseVersionPredicate(predicate: string): VersionPredicate {
  const terms: PredicateTerm[] = [];
  if (predicate.length === 0 || predicate === "*") return { source: predicate, terms };

  for (const raw of predicate.split(" ")) {
    let s = raw.trim();
    if (s.length === 0 || s === "*") continue;

    let operator = OPERATORS.find((o) => o.op === "=")!;
    for (const candidate of OPERATORS) {
      if (s.startsWith(candidate.op)) {
        operator = candidate;
        s = s.substring(candidate.op.length);
        break;
      }
    }

    let version = parseVersion(s, true);
    let op = operator.op;

    if (version.kind === "semantic") {
      if (hasWildcard(version)) {
        if (op !== "=") {
          throw new VersionParsingError(
            `Invalid predicate: ${predicate}, version ranges with wildcards (.X) require using the equality operator or no operator at all!`
          );
        }
        const compCount = version.components.length;
        const newComponents = version.components.slice(0, compCount - 1);
        if (newComponents.length === 0 || newComponents[0] === COMPONENT_WILDCARD) {
          // new SemanticVersionImpl(int[], ...) throws IllegalArgumentException for "x.x".
          throw new VersionParsingError(`Invalid predicate: ${predicate}, invalid components`);
        }
        const build = version.build;
        version = semantic(newComponents, "", build);

        if (compCount <= 1) {
          throw new VersionParsingError(`invalid component count ${compCount} for version ${version.friendly}`);
        } else if (compCount <= 3) {
          // 2, 3 -> represent a.x as ^a-, a.b.x as ~a.b-
          op = compCount === 2 ? "^" : "~";
        } else {
          // > 3 -> represent a.b.c.x as >=a.b.c- <a.b.(c+1)-
          terms.push({ op: ">=", version });
          const upper = newComponents.slice();
          upper[upper.length - 1]++;
          version = semantic(upper, "", null);
          op = "<";
        }
      }
    } else if (!operator.minInclusive && !operator.maxInclusive) {
      throw new VersionParsingError(
        `Invalid predicate: ${predicate}, version ranges need to be semantic version compatible to use operators that exclude the bound!`
      );
    } else {
      op = "=";
    }

    terms.push({ op, version });
  }

  return { source: predicate, terms };
}

function testTerm(term: PredicateTerm, a: FabricVersion): boolean {
  const b = term.version;
  if (a.kind !== "semantic" || b.kind !== "semantic") {
    const operator = OPERATORS.find((o) => o.op === term.op)!;
    return operator.minInclusive || operator.maxInclusive ? a.friendly === b.friendly : false;
  }
  const cmp = compareSemantic(a, b);
  switch (term.op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "~":
      return cmp >= 0 && component(a, 0) === component(b, 0) && component(a, 1) === component(b, 1);
    case "^":
      return cmp >= 0 && component(a, 0) === component(b, 0);
  }
}

export function testVersionPredicate(predicate: VersionPredicate, version: FabricVersion): boolean {
  return predicate.terms.every((term) => testTerm(term, version));
}

/**
 * A fabric.mod.json dependency value: one predicate string or an array of them, ORed.
 * An empty array matches nothing, as in ModDependencyImpl.
 */
export function parseDependencyPredicates(value: unknown): VersionPredicate[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    if (typeof entry !== "string") {
      throw new VersionParsingError(`Dependency version must be a string or an array of strings, got ${JSON.stringify(entry)}`);
    }
    return parseVersionPredicate(entry);
  });
}

export function matchesAnyPredicate(predicates: VersionPredicate[], version: FabricVersion): boolean {
  return predicates.some((predicate) => testVersionPredicate(predicate, version));
}
