export type AccuracyCategory = "content" | "instruction" | "language";
export type ResponseLanguage = "en" | "pt-BR";

export type AccuracyCheck =
  | {
      id: string;
      category: AccuracyCategory;
      kind: "required";
      patterns: string[];
      description: string;
    }
  | {
      id: string;
      category: AccuracyCategory;
      kind: "forbidden";
      patterns: string[];
      description: string;
    }
  | {
      id: string;
      category: "language";
      kind: "language";
      expected: ResponseLanguage;
      description: string;
    }
  | {
      id: string;
      category: "instruction";
      kind: "max_words";
      max: number;
      description: string;
    };

export interface CheckResult {
  id: string;
  category: AccuracyCategory;
  kind: AccuracyCheck["kind"];
  passed: boolean;
  description: string;
}

export interface Evaluation {
  checks: CheckResult[];
  contentPassed: number;
  contentTotal: number;
  instructionPassed: number;
  instructionTotal: number;
  languagePassed: boolean | null;
  languageTotal: number;
  allChecksPassed: boolean;
  contentAligned: boolean;
  accuracyPercent: number;
  detectedLanguage: "en" | "pt-BR" | "unknown";
  wordCount: number;
  failedChecks: string[];
}

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

export function formatIssues(value: string): string[] {
  const issues: string[] = [];
  const lines = value.split(/\r?\n/);
  if (lines.some(line => /^\s*#{1,6}\s+/.test(line))) issues.push("heading");
  if (lines.some(line => /^\s*(?:[-*+•·]|\d+[.)])\s+/.test(line))) issues.push("list");
  if (lines.some(line => /^\s*```/.test(line))) issues.push("code");
  if (lines.some(line => /^\s*\|.*\|\s*$/.test(line) || /^\s*:?-{3,}:?\s*\|/.test(line))) issues.push("table");
  return issues;
}

/** Small stop-word heuristic for the two languages the product supports. */
export function detectLanguage(value: string): "en" | "pt-BR" | "unknown" {
  const text = normalizeAnswer(value);
  const english = text.match(/\b(?:the|and|is|are|of|to|in|that|this|with|for|as|by|on|from|be|it|an|we|can|which|using|while|when)\b/g)?.length ?? 0;
  const portuguese = text.match(/\b(?:que|de|da|do|das|dos|é|são|para|com|uma|um|não|em|os|as|por|se|no|na|ao|como|mais|este|esta|isso|também|entre|sobre|quando)\b/g)?.length ?? 0;
  if (portuguese === english) return "unknown";
  return portuguese > english ? "pt-BR" : "en";
}

function matchesAny(text: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    try {
      return new RegExp(pattern, "iu").test(text);
    } catch (error) {
      throw new Error(`Regex inválida em accuracy_eval: ${pattern}: ${String(error)}`);
    }
  });
}

export function evaluateAnswer(answer: string, checks: AccuracyCheck[]): Evaluation {
  const normalized = normalizeAnswer(answer);
  const detectedLanguage = detectLanguage(answer);
  const checkResults = checks.map((check): CheckResult => {
    let passed = false;
    if (check.kind === "required") passed = matchesAny(normalized, check.patterns);
    else if (check.kind === "forbidden") passed = !matchesAny(normalized, check.patterns);
    else if (check.kind === "language") passed = detectedLanguage === check.expected;
    else passed = wordCount(answer) <= check.max;
    return { id: check.id, category: check.category, kind: check.kind, passed, description: check.description };
  });
  const content = checkResults.filter(check => check.category === "content");
  const instruction = checkResults.filter(check => check.category === "instruction");
  const language = checkResults.filter(check => check.category === "language");
  const passed = checkResults.filter(check => check.passed).length;
  const contentPassed = content.filter(check => check.passed).length;
  const languagePassed = language.length ? language.every(check => check.passed) : null;
  return {
    checks: checkResults,
    contentPassed,
    contentTotal: content.length,
    instructionPassed: instruction.filter(check => check.passed).length,
    instructionTotal: instruction.length,
    languagePassed,
    languageTotal: language.length,
    allChecksPassed: checkResults.every(check => check.passed),
    contentAligned: content.length > 0 && contentPassed === content.length && languagePassed !== false,
    accuracyPercent: checkResults.length ? (passed / checkResults.length) * 100 : 0,
    detectedLanguage,
    wordCount: wordCount(answer),
    failedChecks: checkResults.filter(check => !check.passed).map(check => check.id),
  };
}
