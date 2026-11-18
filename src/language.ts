export type QuestionLanguage = "en" | "pt-BR" | "unknown";

// Short questions may contain only a few words, so the lists use distinctive
// function words and keep ambiguous tokens (a, no, do, as, e) out.
const PORTUGUESE_WORDS = new Set([
  "não", "uma", "para", "com", "como", "por", "porque", "porquê", "qual", "quais",
  "quando", "onde", "isso", "isto", "este", "esta", "esse", "essa", "destes", "destas",
  "dos", "das", "pelo", "pela", "mais", "menos", "entre", "sobre", "também", "então",
  "é", "são", "está", "estão", "foi", "foram", "ser", "sendo", "tem", "têm", "há",
  "usar", "usa", "usado", "utilizar", "utiliza", "funciona", "funcionam",
  "explica", "explique", "explicar", "diferença", "artigo", "autor", "autores",
  "modelo", "modelos", "trecho", "trechos", "pergunta", "perguntas", "resposta",
  "respostas", "significa", "sentido", "faz", "fazer", "melhor", "detalhes",
  "resultado", "resultados", "atenção", "selecionado", "selecionada", "contexto",
]);
const ENGLISH_WORDS = new Set([
  "the", "is", "are", "what", "why", "how", "does", "with", "for", "and", "this",
  "that", "these", "those", "of", "to", "can", "would", "should", "between", "which",
  "explain", "difference", "article", "paper", "because", "when", "where", "was",
  "were", "has", "have", "not", "from", "about", "used", "works", "work", "its",
  "they", "their", "there", "than", "then", "into", "mean", "meaning", "passage",
]);
const PORTUGUESE_MARKS = /[ãõçáéíóúâêôà]/u;

/** Detect the language of the user's question, never of the article. */
export function detectQuestionLanguage(question: string): QuestionLanguage {
  const text = question.toLowerCase().normalize("NFC");
  const words = text.match(/\p{L}+/gu) ?? [];
  if (!words.length) return "unknown";
  let portuguese = PORTUGUESE_MARKS.test(text) ? 2 : 0;
  let english = 0;
  for (const word of words) {
    if (PORTUGUESE_WORDS.has(word)) portuguese += 1;
    if (ENGLISH_WORDS.has(word)) english += 1;
  }
  if (portuguese === english) return "unknown";
  return portuguese > english ? "pt-BR" : "en";
}
