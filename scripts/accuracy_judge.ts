import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type JudgeLabel = "supported" | "contradicted" | "not_in_source" | "irrelevant";

export interface JudgeConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface AtomicClaim {
  id: string;
  text: string;
}

export interface ClaimVerdict extends AtomicClaim {
  label: JudgeLabel;
  evidence: string;
  reason: string;
}

export interface CoverageVerdict {
  keyfact: string;
  covered: boolean;
  evidence: string;
}

export interface DirectnessEvaluation {
  answersQuestion: boolean;
  noUnrequestedContent: boolean;
  didactic: boolean;
  reason: string;
}

export interface JudgeEvaluation {
  claims: ClaimVerdict[];
  supported: number;
  contradicted: number;
  notInSource: number;
  irrelevant: number;
  precision: number;
  contradictionRate: number;
  coverage: CoverageVerdict[];
  coverageRate: number | null;
  directness: DirectnessEvaluation;
  directnessPassed: boolean;
  judgeModel: string;
  promptVersion: string;
}

export const PROMPT_VERSION = "factscore-2";

const DECOMPOSE_SYSTEM = `You extract atomic factual claims for scientific fact-checking.
Return only a JSON object. Do not answer the question and do not judge the claims.`;

const VERIFY_SYSTEM = `You are a strict fact-checker for a scientific paper.
Use only the article provided. Never use outside knowledge.
Return only a JSON object with one verdict per claim.`;

const COVERAGE_SYSTEM = `You check whether an answer covers a list of key facts.
Judge meaning, not exact wording. Return only a JSON object.`;

const DIRECTNESS_SYSTEM = `You evaluate whether an answer follows a product's answer policy.
Return only a JSON object. Do not judge factual accuracy in this step.`;

function readDotEnv(): Record<string, string> {
  const path = resolve(process.cwd(), ".env");
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function loadJudgeConfig(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const file = readDotEnv();
  const get = (name: string) => env[name] ?? file[name];
  const apiKey = get("DEEPINFRA_API_KEY") ?? get("deepinfra_key") ?? "";
  const model = get("DEEPINFRA_MODEL") ?? get("deepinfra_model") ?? "";
  const baseUrl = get("DEEPINFRA_BASE_URL") ?? "https://api.deepinfra.com/v1/openai";
  if (!apiKey) throw new Error("Defina deepinfra_key (ou DEEPINFRA_API_KEY) no .env para usar o juiz.");
  if (!model) throw new Error("Defina deepinfra_model (ou DEEPINFRA_MODEL) no .env para usar o juiz.");
  return { apiKey, model, baseUrl: baseUrl.replace(/\/+$/, "") };
}

export function parseJsonObject(value: string): Record<string, unknown> {
  let text = value.trim();
  if (text.startsWith("```")) text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("O juiz não retornou um objeto JSON.");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("O juiz não retornou um objeto JSON.");
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLabel(value: unknown): JudgeLabel {
  const label = asString(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (label === "supported") return "supported";
  if (label === "contradicted" || label === "contradiction") return "contradicted";
  if (label === "irrelevant") return "irrelevant";
  return "not_in_source";
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  const text = asString(value).toLowerCase();
  return text === "true" || text === "yes" || text === "sim";
}

function normalizeClaimText(value: unknown): string {
  return asString(value).replace(/\s+/g, " ");
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

const pause = (ms: number) => new Promise(done => setTimeout(done, ms));

export class JudgeClient {
  readonly config: JudgeConfig;
  private fetcher: typeof fetch;

  constructor(config: JudgeConfig = loadJudgeConfig(), fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<Record<string, unknown>> {
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            temperature: 0,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
          }),
          signal: AbortSignal.timeout(240000),
        });
        if (!response.ok) {
          lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`;
          if (response.status === 429 || response.status >= 500) {
            await pause(1000 * (attempt + 1));
            continue;
          }
          throw new Error(`Juiz recusou o pedido (${lastError}).`);
        }
        const data = await response.json() as { choices?: { message?: { content?: unknown } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("O juiz não retornou conteúdo.");
        return parseJsonObject(content);
      } catch (error) {
        lastError = String(error);
        if (attempt < 2) {
          await pause(1000 * (attempt + 1));
          continue;
        }
      }
    }
    throw new Error(`Falha ao consultar o juiz: ${lastError}`);
  }

  async decompose(question: string, answer: string): Promise<AtomicClaim[]> {
    const data = await this.chat(DECOMPOSE_SYSTEM, `QUESTION:
${question}

ANSWER:
${answer}

Break the answer into atomic factual claims. Rules:
- one verifiable fact per claim, self-contained (resolve pronouns and references);
- preserve numbers, units, entities and formulas exactly;
- do not include opinions, hedges, questions or meta-comments;
- merge near-duplicate claims and paraphrases of the same fact into one claim;
- do not create claims that merely restate the question or describe the answer's structure;
- do not add facts that are not in the answer;
- if the answer correctly says that the article does not report something, keep that as one claim.

Return JSON: {"claims":[{"id":"c1","text":"..."}]}. Use at most 40 claims.`, 3072);
    const raw = Array.isArray(data.claims) ? data.claims : [];
    const claims: AtomicClaim[] = [];
    for (const item of raw) {
      const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const text = normalizeClaimText(record.text);
      if (!text) continue;
      claims.push({ id: `c${claims.length + 1}`, text });
      if (claims.length >= 40) break;
    }
    return claims;
  }

  async verify(question: string, claims: AtomicClaim[], article: string): Promise<ClaimVerdict[]> {
    const verdicts = new Map<string, ClaimVerdict>();
    for (const batch of batches(claims, 6)) {
      const listed = batch.map(claim => `[${claim.id}] ${claim.text}`).join("\n");
      const data = await this.chat(VERIFY_SYSTEM, `ARTICLE:
<article>
${article}
</article>

QUESTION: ${question}

CLAIMS:
${listed}

For each claim, search the article and assign exactly one label:
- "supported": the article entails the claim. A claim that the article does not report X is supported only if the article truly omits X.
- "contradicted": the article states the opposite, a conflicting number, or a conflicting fact.
- "not_in_source": the article does not contain enough evidence to decide, and the claim is not a correct absence claim.
- "irrelevant": the claim is not about the article or the question, or is opinion/meta.

Also quote the shortest evidence span from the article that justifies the label. Use an empty string if there is no span. Be strict: a plausible claim without textual support is "not_in_source", not "supported".

Return JSON: {"verdicts":[{"id":"c1","label":"supported","evidence":"...","reason":"..."}]}. Include every claim exactly once.`, 3072);
      const raw = Array.isArray(data.verdicts) ? data.verdicts : [];
      for (const item of raw) {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        const id = asString(record.id);
        const claim = batch.find(entry => entry.id === id);
        if (!claim) continue;
        verdicts.set(id, {
          ...claim,
          label: normalizeLabel(record.label),
          evidence: asString(record.evidence),
          reason: asString(record.reason),
        });
      }
      for (const claim of batch) {
        if (!verdicts.has(claim.id)) {
          verdicts.set(claim.id, { ...claim, label: "not_in_source", evidence: "", reason: "O juiz não retornou veredito para esta claim." });
        }
      }
    }
    return claims.map(claim => verdicts.get(claim.id)!);
  }

  async coverage(keyfacts: string[], answer: string): Promise<CoverageVerdict[]> {
    if (!keyfacts.length) return [];
    const data = await this.chat(COVERAGE_SYSTEM, `ANSWER:
${answer}

KEY FACTS:
${keyfacts.map((fact, index) => `[k${index + 1}] ${fact}`).join("\n")}

For each key fact, decide whether the answer conveys it. Judge meaning, not exact wording. Return JSON: {"coverage":[{"keyfact":"k1","covered":true,"evidence":"..."}]}. Include every key fact exactly once.`, 2048);
    const raw = Array.isArray(data.coverage) ? data.coverage : [];
    const coverage: CoverageVerdict[] = [];
    for (let index = 0; index < keyfacts.length; index++) {
      const id = `k${index + 1}`;
      const record = raw.find(item => item && typeof item === "object" && asString((item as Record<string, unknown>).keyfact) === id) as Record<string, unknown> | undefined;
      coverage.push({
        keyfact: keyfacts[index],
        covered: record?.covered === true,
        evidence: asString(record?.evidence),
      });
    }
    return coverage;
  }

  async directness(question: string, answer: string): Promise<DirectnessEvaluation> {
    const data = await this.chat(DIRECTNESS_SYSTEM, `QUESTION:
${question}

ANSWER:
${answer}

Evaluate three binary criteria:
- answers_question: does the answer address the question that was asked?
- no_unrequested_content: does the answer avoid background, examples, sections, caveats, lists, tables, headings, or repetition that the question did not ask for?
- didactic: does the answer explain the terms needed to understand it, without being cryptic or bloated?

Do not judge factual accuracy. Return JSON: {"answers_question":true,"no_unrequested_content":true,"didactic":true,"reason":"..."}.`, 1024);
    return {
      answersQuestion: truthy(data.answers_question),
      noUnrequestedContent: truthy(data.no_unrequested_content),
      didactic: truthy(data.didactic),
      reason: asString(data.reason),
    };
  }

  async evaluate(question: string, answer: string, article: string, keyfacts: string[] = []): Promise<JudgeEvaluation> {
    const claims = await this.decompose(question, answer);
    const verdicts = await this.verify(question, claims, article);
    const coverage = await this.coverage(keyfacts, answer);
    const directness = await this.directness(question, answer);
    const supported = verdicts.filter(verdict => verdict.label === "supported").length;
    const contradicted = verdicts.filter(verdict => verdict.label === "contradicted").length;
    const notInSource = verdicts.filter(verdict => verdict.label === "not_in_source").length;
    const irrelevant = verdicts.filter(verdict => verdict.label === "irrelevant").length;
    return {
      claims: verdicts,
      supported,
      contradicted,
      notInSource,
      irrelevant,
      precision: verdicts.length ? supported / verdicts.length : 0,
      contradictionRate: verdicts.length ? contradicted / verdicts.length : 0,
      coverage,
      coverageRate: coverage.length ? coverage.filter(item => item.covered).length / coverage.length : null,
      directness,
      directnessPassed: directness.answersQuestion && directness.noUnrequestedContent && directness.didactic,
      judgeModel: this.config.model,
      promptVersion: PROMPT_VERSION,
    };
  }
}
