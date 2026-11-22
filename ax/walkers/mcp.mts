// Friends' MCP walker: the tools the friends server serves, carded from their ouro-actions declarations. The built-in
// mcp-schemas walker can't read them: friends' getToolSchemas() returns the generated catalog, whose names have no
// `name:` literal in TypeScript, and its cards would have to be served on tools/list.
//
// A source's `module` is the served catalog, `actions/generated/mcp.json`: `{ "tools": [{ "name", "description",
// "annotations" }] }`, the file getToolSchemas() returns and tools/list answers. Each tool is a door. `source` is the
// declarations module, `actions/friends.actions.mts`, whose syntax tree gives each door its line: the `id: "<name>"`
// literal in the object a `defineAction(...)` call takes. A name with no such literal is a door with line null.
//
// `cards` is the sidecar, `ax/cards/mcp.json`: `{ "declarations": <actions.json path>, "errors": [ErrorCard],
// "groups": { <group id>: [tool names] } }`. A tool's card is its declaration in actions.json, the file ouro-actions
// generates from friends.actions.mts: `when`, `errors`, `consent` as the effect, and `destructive`, `idempotent` and
// `confirm` where declared, with the group the sidecar puts it in. ouro-actions has no group field, so the group is the
// one part of a card the sidecar holds. A declaration without a `when` line is no card yet. `errors` are the server's
// own (an `unknown-door` card, the answer to a tool name it doesn't serve). A declaration or group entry naming a tool
// the server doesn't serve is a census error, so a card can't outlive its tool.
//
// `handlers` are the files or folders that raise the tools' error codes: a card's code counts as raised when one of them
// holds it as a string literal outside an error card, as written or with its hyphens as underscores (friends' statuses
// are snake_case on the wire, a card's codes are kebab-case).
//
// Read-only evidence is the served `readOnlyHint`. Nothing here calls a tool.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, ErrorCard, WalkerOptions, WalkResult } from "../../lib/ouro-ui/scripts/ouro-census/types.mts";

interface Tool {
  name: string;
  description: string;
  readOnly: boolean;
}

interface Declaration {
  id: string;
  consent?: DoorCard["effect"];
  when?: string;
  errors?: ErrorCard[];
  destructive?: true;
  idempotent?: true;
  confirm?: string;
}

const SCRIPT = /\.[cm]?[jt]s$/;
const SKIP = new Set(["node_modules", "__tests__", "fixtures"]);

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const keyText = (name: ts.PropertyName | undefined): string | null => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null);
const firstLine = (error: unknown): string => String((error as Error)?.message ?? error).split("\n")[0];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

/** The line of each `id: "<name>"` literal in the object a `defineAction(...)` call takes. */
function idLines(path: string): Map<string, number> {
  const sf = parse(path);
  const lines = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineAction") {
      const [arg] = node.arguments;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p) && keyText(p.name) === "id" && isText(p.initializer) && !lines.has(p.initializer.text)) {
            lines.set(p.initializer.text, sf.getLineAndCharacterOfPosition(p.initializer.getStart(sf)).line + 1);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function readCatalog(path: string, label: string, errors: string[]): Tool[] {
  let catalog: { tools?: { name?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown } }[] };
  try {
    catalog = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label}: can't read the catalog: ${firstLine(error)}`);
    return [];
  }
  if (!Array.isArray(catalog.tools)) {
    errors.push(`${label}: a catalog with no tools list`);
    return [];
  }
  const tools: Tool[] = [];
  for (const t of catalog.tools) {
    if (typeof t?.name !== "string" || t.name.length === 0) {
      errors.push(`${label}: a tool without a name`);
      continue;
    }
    tools.push({ name: t.name, description: typeof t.description === "string" ? t.description : "", readOnly: t.annotations?.readOnlyHint === true });
  }
  return tools;
}

interface Sidecar {
  declarations: Map<string, Declaration>;
  declarationsFile: string;
  errors: ErrorCard[];
  groupOf: Map<string, string>;
  grouped: string[];
}

function readSidecar(root: string, path: string, errors: string[]): Sidecar | null {
  let parsed: { declarations?: unknown; errors?: unknown; groups?: unknown };
  try {
    parsed = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: can't read the cards: ${firstLine(error)}`);
    return null;
  }
  if (typeof parsed.declarations !== "string") {
    errors.push(`${path}: names no declarations file`);
    return null;
  }
  const declarationsFile = parsed.declarations;
  let actions: unknown;
  try {
    actions = (JSON.parse(readFileSync(resolve(root, declarationsFile), "utf8")) as { actions?: unknown }).actions;
  } catch (error) {
    errors.push(`${declarationsFile}: can't read the declarations: ${firstLine(error)}`);
    return null;
  }
  if (!Array.isArray(actions)) {
    errors.push(`${declarationsFile}: has no actions list`);
    return null;
  }
  const declarations = new Map<string, Declaration>();
  for (const a of actions as Declaration[]) if (typeof a?.id === "string") declarations.set(a.id, a);
  const groupOf = new Map<string, string>();
  const grouped: string[] = [];
  const groups = parsed.groups && typeof parsed.groups === "object" ? (parsed.groups as Record<string, unknown>) : {};
  for (const [group, names] of Object.entries(groups)) {
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== "string") continue;
      const before = groupOf.get(name);
      if (before !== undefined) errors.push(`mcp:${name}: in two groups in ${path}, ${before} and ${group}`);
      else {
        groupOf.set(name, group);
        grouped.push(name);
      }
    }
  }
  return { declarations, declarationsFile, errors: Array.isArray(parsed.errors) ? (parsed.errors as ErrorCard[]) : [], groupOf, grouped };
}

function scriptFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP.has(e.name) ? [] : scriptFiles(join(path, e.name))) : SCRIPT.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name) ? [join(path, e.name)] : []));
}

/** Every string literal in the handler files, outside error cards. */
function raisedLiterals(root: string, handlers: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const handler of handlers) {
    for (const file of scriptFiles(resolve(root, handler))) {
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const keys = new Set(node.properties.map((p) => keyText(p.name)));
          if (keys.has("code") && keys.has("means") && keys.has("fix")) return;
        }
        if (isText(node)) found.add(node.text);
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
    }
  }
  return found;
}

const raised = (literals: ReadonlySet<string>, code: unknown): boolean => typeof code === "string" && (literals.has(code) || literals.has(code.replaceAll("-", "_")));

function cardOf(id: string, d: Declaration, group: string | undefined): DoorCard {
  return {
    id,
    group: group ?? "",
    when: d.when!,
    effect: d.consent!,
    errors: Array.isArray(d.errors) ? d.errors : [],
    ...(d.destructive === true ? { destructive: true as const } : {}),
    ...(d.idempotent === true ? { idempotent: true as const } : {}),
    ...(typeof d.confirm === "string" ? { confirm: d.confirm } : {}),
  };
}

export async function walk(opts: WalkerOptions): Promise<WalkResult> {
  const catalog = relative(opts.root, resolve(opts.root, opts.module));
  const errors: string[] = [];
  const tools = readCatalog(resolve(opts.root, opts.module), catalog, errors);
  const sourcePath = resolve(opts.root, opts.source);
  const file = relative(opts.root, sourcePath);
  const lines = idLines(sourcePath);
  const sidecar = opts.cards ? readSidecar(opts.root, opts.cards, errors) : null;
  const literals = raisedLiterals(opts.root, opts.handlers ?? []);
  const doors: Door[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const id = `mcp:${tool.name}`;
    if (seen.has(id)) {
      errors.push(`${id}: listed twice in ${catalog}`);
      continue;
    }
    seen.add(id);
    const declaration = sidecar?.declarations.get(tool.name);
    const card = declaration && typeof declaration.when === "string" ? cardOf(id, declaration, sidecar!.groupOf.get(tool.name)) : null;
    doors.push({
      id,
      kind: "mcp",
      product: opts.product,
      name: tool.name,
      description: tool.description,
      file,
      line: lines.get(tool.name) ?? null,
      card,
      evidence: {
        ...(tool.readOnly ? { readOnly: true } : {}),
        ...(card && opts.handlers ? { raises: card.errors.map((e) => e?.code).filter((code) => raised(literals, code)) } : {}),
      },
    });
  }
  if (sidecar) {
    for (const name of sidecar.grouped) if (!seen.has(`mcp:${name}`)) errors.push(`mcp:${name}: grouped in ${opts.cards}, but ${catalog} doesn't serve it. Fix: remove it from the group, or serve the tool.`);
    for (const name of sidecar.declarations.keys()) if (!seen.has(`mcp:${name}`)) errors.push(`mcp:${name}: declared in ${sidecar.declarationsFile}, but ${catalog} doesn't serve it. Fix: remove the declaration, or serve the tool.`);
    if (doors.some((d) => d.card)) {
      if (!sidecar.errors.some((e) => e?.code === "unknown-door")) errors.push(`${opts.cards}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`);
      else if (opts.handlers && !raised(literals, "unknown-door")) errors.push(`${opts.cards}: the unknown-door code is never raised in ${opts.handlers.join(", ")}`);
    }
  }
  return { doors, errors };
}
