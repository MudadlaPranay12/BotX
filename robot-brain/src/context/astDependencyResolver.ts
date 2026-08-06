import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedDependency {
    moduleSpecifier: string;
    targetFile: string;
    importedSymbols: string[];
    exports: string[];
}

interface RequestedSymbols {
    symbols: string[];
    resolveAll: boolean;
}

interface SourceFileCacheEntry {
    contentHash: string;
    sourceFile: ts.SourceFile;
}

interface ExportCacheEntry {
    contentHash: string;
    exportsBySymbol: Map<string, string>;
    allExports: string[];
    hasDefaultExport: boolean;
}

const MAX_TARGET_FILE_BYTES = 256 * 1024;
const MAX_EXPORTS_PER_FILE = 12;
const MAX_EXPORT_TEXT_LENGTH = 800;

function hashCode(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return String(hash);
}

function isTsLikeFileName(fileName: string): boolean {
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(fileName);
}

function inferScriptKind(fileName: string): ts.ScriptKind {
    if (/\.tsx$/i.test(fileName)) {
        return ts.ScriptKind.TSX;
    }
    if (/\.jsx$/i.test(fileName)) {
        return ts.ScriptKind.JSX;
    }
    if (/\.(js|mjs|cjs)$/i.test(fileName)) {
        return ts.ScriptKind.JS;
    }
    return ts.ScriptKind.TS;
}

/**
 * Lightweight AST-based import & dependency resolver built on the TypeScript
 * Compiler API. For a file with diagnostics it:
 *   - parses the file into a SourceFile AST,
 *   - collects the identifiers referenced on the error lines,
 *   - maps those identifiers to import bindings,
 *   - resolves the module specifier to a workspace file and extracts the
 *     exported interfaces/types/functions (signatures) for the used symbols.
 *
 * ASTs and resolved exports are cached keyed by content hash so unchanged
 * files are never re-parsed (keeps latency low).
 */
export class AstDependencyResolver {
    private sourceFileCache: Map<string, SourceFileCacheEntry> = new Map();
    private exportCache: Map<string, ExportCacheEntry> = new Map();

    resolve(filePath: string, fileContent: string, errorLines: number[]): ResolvedDependency[] {
        if (!filePath || !fileContent || !isTsLikeFileName(filePath) || errorLines.length === 0) {
            return [];
        }

        const sourceFile = this.getOrParse(filePath, fileContent);
        if (!sourceFile) {
            return [];
        }

        const errorIdentifiers = this.collectIdentifiersOnLines(sourceFile, new Set(errorLines));
        if (errorIdentifiers.size === 0) {
            return [];
        }

        const resolved: ResolvedDependency[] = [];
        for (const statement of sourceFile.statements) {
            if (!ts.isImportDeclaration(statement)) {
                continue;
            }

            const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : "";
            if (!moduleSpecifier) {
                continue;
            }

            const importClause = statement.importClause;
            if (!importClause) {
                continue;
            }

            const requested = this.collectRequestedSymbols(sourceFile, importClause, errorIdentifiers);
            if (requested.symbols.length === 0 && !requested.resolveAll) {
                continue;
            }

            const targetFile = this.resolveModuleToFile(sourceFile.fileName, moduleSpecifier);
            if (!targetFile) {
                continue;
            }

            const exports = this.extractExports(targetFile, requested);
            if (exports.length === 0) {
                continue;
            }

            resolved.push({
                moduleSpecifier,
                targetFile,
                importedSymbols: requested.symbols.length > 0 ? requested.symbols : ["*"],
                exports
            });
        }

        return resolved;
    }

    format(dependencies: ResolvedDependency[]): string {
        if (dependencies.length === 0) {
            return "";
        }
        return dependencies
            .map((dep) => {
                const used = dep.importedSymbols.join(", ");
                const exportsText = dep.exports.map((entry) => `    ${entry}`).join("\n");
                return `- ${dep.targetFile} (import '${dep.moduleSpecifier}', used: ${used}):\n${exportsText}`;
            })
            .join("\n\n");
    }

    clear(): void {
        this.sourceFileCache.clear();
        this.exportCache.clear();
    }

    private collectRequestedSymbols(
        sourceFile: ts.SourceFile,
        importClause: ts.ImportClause,
        errorIdentifiers: Set<string>
    ): RequestedSymbols {
        const symbols: string[] = [];
        let resolveAll = false;

        if (importClause.name && errorIdentifiers.has(importClause.name.text)) {
            symbols.push("default");
        }

        const namedBindings = importClause.namedBindings;
        if (namedBindings) {
            if (ts.isNamespaceImport(namedBindings)) {
                const ns = namedBindings.name.text;
                if (errorIdentifiers.has(ns)) {
                    resolveAll = true;
                    symbols.push(...this.findNamespaceMembers(sourceFile, ns));
                }
            } else if (ts.isNamedImports(namedBindings)) {
                for (const specifier of namedBindings.elements) {
                    const localName = specifier.name.text;
                    if (errorIdentifiers.has(localName)) {
                        symbols.push(specifier.propertyName ? specifier.propertyName.text : localName);
                    }
                }
            }
        }

        return { symbols: Array.from(new Set(symbols)), resolveAll };
    }

    private findNamespaceMembers(sourceFile: ts.SourceFile, ns: string): string[] {
        const members = new Set<string>();
        const walk = (node: ts.Node) => {
            if (ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === ns) {
                members.add(node.name.text);
            }
            ts.forEachChild(node, walk);
        };
        ts.forEachChild(sourceFile, walk);
        return Array.from(members);
    }

    private resolveModuleToFile(importerFile: string, specifier: string): string | null {
        if (!specifier.startsWith(".")) {
            return null;
        }
        const baseDir = path.dirname(importerFile);
        const base = path.resolve(baseDir, specifier);
        for (const candidate of this.buildCandidates(base)) {
            if (this.fileExists(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private buildCandidates(base: string): string[] {
        const ext = path.extname(base);
        if (ext && isTsLikeFileName(base)) {
            return [base];
        }
        return [
            base,
            `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}.mts`, `${base}.cts`,
            `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
            `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.d.ts`,
            `${base}/index.js`, `${base}/index.jsx`
        ];
    }

    private extractExports(targetFile: string, requested: RequestedSymbols): string[] {
        const cache = this.getExportCache(targetFile);
        if (!cache) {
            return [];
        }

        if (requested.resolveAll) {
            if (requested.symbols.length > 0) {
                const members = requested.symbols
                    .map((symbol) => cache.exportsBySymbol.get(symbol))
                    .filter((entry): entry is string => !!entry);
                if (members.length > 0) {
                    return members;
                }
            }
            return cache.allExports.slice(0, MAX_EXPORTS_PER_FILE);
        }

        return requested.symbols
            .map((symbol) => cache.exportsBySymbol.get(symbol))
            .filter((entry): entry is string => !!entry);
    }

    private getExportCache(targetFile: string): ExportCacheEntry | undefined {
        if (!this.fileExists(targetFile)) {
            return undefined;
        }

        let content: string;
        try {
            const stat = fs.statSync(targetFile);
            if (stat.size > MAX_TARGET_FILE_BYTES) {
                return undefined;
            }
            content = fs.readFileSync(targetFile, "utf-8");
        } catch {
            return undefined;
        }

        const contentHash = hashCode(content);
        const existing = this.exportCache.get(targetFile);
        if (existing && existing.contentHash === contentHash) {
            return existing;
        }

        const entry = this.buildExportCache(targetFile, content, contentHash);
        this.exportCache.set(targetFile, entry);
        return entry;
    }

    private buildExportCache(fileName: string, content: string, contentHash: string): ExportCacheEntry {
        const exportsBySymbol = new Map<string, string>();
        const allExports: string[] = [];
        let hasDefaultExport = false;

        const sourceFile = this.getOrParse(fileName, content);
        if (sourceFile) {
            for (const statement of sourceFile.statements) {
                if (!this.isExported(statement)) {
                    continue;
                }

                if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
                    exportsBySymbol.set("default", this.cap(statement.expression.text, MAX_EXPORT_TEXT_LENGTH));
                    hasDefaultExport = true;
                    continue;
                }

                const name = this.getDeclarationName(statement);
                if (!name) {
                    continue;
                }

                const text = this.cap(statement.getText(sourceFile), MAX_EXPORT_TEXT_LENGTH);
                if (!exportsBySymbol.has(name)) {
                    exportsBySymbol.set(name, text);
                    allExports.push(`${name}: ${text}`);
                }
                if (this.hasDefaultModifier(statement)) {
                    exportsBySymbol.set("default", text);
                    hasDefaultExport = true;
                }
            }
        }

        return { contentHash, exportsBySymbol, allExports, hasDefaultExport };
    }

    private isExported(node: ts.Node): boolean {
        return node.getText().trimStart().startsWith("export");
    }

    private hasDefaultModifier(node: ts.Node): boolean {
        const text = node.getText().trimStart();
        return text.startsWith("export default");
    }

    private getDeclarationName(statement: ts.Statement): string | null {
        if (ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) {
            return statement.name ? statement.name.text : null;
        }
        if (ts.isVariableStatement(statement)) {
            const declaration = statement.declarationList.declarations[0];
            if (declaration && ts.isIdentifier(declaration.name)) {
                return declaration.name.text;
            }
        }
        return null;
    }

    private collectIdentifiersOnLines(sourceFile: ts.SourceFile, lines: Set<number>): Set<string> {
        const identifiers = new Set<string>();
        const walk = (node: ts.Node) => {
            if (ts.isIdentifier(node)) {
                const { line } = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart());
                if (lines.has(line + 1)) {
                    identifiers.add(node.text);
                }
            }
            ts.forEachChild(node, walk);
        };
        ts.forEachChild(sourceFile, walk);
        return identifiers;
    }

    private getOrParse(fileName: string, content: string): ts.SourceFile | undefined {
        const contentHash = hashCode(content);
        const existing = this.sourceFileCache.get(fileName);
        if (existing && existing.contentHash === contentHash) {
            return existing.sourceFile;
        }
        try {
            const sourceFile = ts.createSourceFile(
                fileName,
                content,
                ts.ScriptTarget.Latest,
                true,
                inferScriptKind(fileName)
            );
            this.sourceFileCache.set(fileName, { contentHash, sourceFile });
            return sourceFile;
        } catch {
            return undefined;
        }
    }

    private fileExists(filePath: string): boolean {
        try {
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    private cap(text: string, maxLength: number): string {
        if (text.length <= maxLength) {
            return text;
        }
        return text.slice(0, maxLength).replace(/\s+\S*$/, "") + "\n// ... (truncated)";
    }
}
