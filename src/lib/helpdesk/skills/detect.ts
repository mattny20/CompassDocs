// Helpdesk 1.19.2: the ticket language detector (agent W2). Small, pure and
// dependency-free, and it runs only on this server: the text is never sent
// anywhere. It knows English, French, German, Spanish, Italian, Portuguese
// and Dutch (HD_DETECTABLE_LANGUAGES), and answers null when the text is
// too short or too mixed to tell, so a ticket is never routed on a guess.
//
// How: the common short words of each language (articles, pronouns,
// prepositions, "please", "thanks") are counted, each weighted by how many
// of the languages share it ("de" is Dutch, Spanish, Portuguese and French;
// "und" is only German), plus a few letters only some of them use (ß, ñ,
// ã). The quoted thread under a reply and signatures' links are dropped
// first, so a French reply to an English email reads as French.

import type { HD_DETECTABLE_LANGUAGES } from "./shared";

type Lang = (typeof HD_DETECTABLE_LANGUAGES)[number];

const WORDS: Record<Lang, string> = {
  en: `the and is are was were to of in it that this with for you your not have has had can my i i'm we our please could would
       should be been on but from they what when there will me an at do does don't cannot can't help thanks thank hello hi dear
       any how which who just get got need it's working work since after again still also because about into`,
  fr: `le la les des est et un une du je j nous vous pas que qui pour dans sur avec mon ma mes ce cette ces il elle sont ne au
       aux bonjour merci mais ou plus très peux pouvez puis ai avons avez été depuis encore aussi votre vos notre nos fonctionne
       marche impossible problème besoin cordialement l d qu n c s y suis être faire fait quand comment pourquoi
       a mot passe ordinateur imprimante écran accès réinitialiser oublié`,
  de: `der die das und ist nicht ich wir sie ein eine einen einem mit für auf den dem zu von mein meine meinen bitte danke kann
       können es im auch sind hallo haben habe hat wird noch nach bei aus kein keine funktioniert geht seit wieder mehr ihr
       ihre unser unsere gruß grüße freundlichen mfg dass wenn wie warum schon gibt problem leider
       passwort drucker bildschirm rechner zugang zurücksetzen vergessen`,
  es: `el los las de que y es en un una por para con no mi mis se lo como pero más está estoy tengo puedo hola gracias favor del
       al muy también funciona nuestro nuestra cuando desde problema necesito saludos usted ustedes su sus este esta hay
       ya porque fue sido hacer ayuda
       a contraseña correo ordenador impresora pantalla acceso restablecer olvidé`,
  it: `il lo la le gli di che e è non un una per con mi sono ho ciao grazie del della dei delle nel nella anche come ma questo
       questa posso può funziona buongiorno cordiali saluti vorrei mio mia miei abbiamo avete essere da al alla sul sulla
       più perché quando ancora problema aiuto già
       a stampante schermo posta accesso riesco reimpostare dimenticato`,
  pt: `o os as de que e é não um uma para com por meu minha eu você está estou tenho posso obrigado obrigada olá bom dia do da
       dos das no na nos mas também funciona preciso ao aos isso este esta seu sua nosso nossa quando ainda já problema ajuda
       consigo favor atenciosamente
       a senha impressora computador tela ecrã acesso redefinir esqueci`,
  nl: `de het een en is niet ik we wij je u van met voor op dat die zijn mijn kan kunt graag bedankt hallo dank ook maar wordt
       werkt heb hebben geen naar bij uit er nog al wel wat hoe waarom sinds probleem groet groeten vriendelijke alstublieft
       jullie onze ons hij zij
       wachtwoord scherm toegang inloggen vergeten`,
};

const LANGS = Object.keys(WORDS) as Lang[];

/** word → the languages that use it. */
const INDEX: Map<string, Lang[]> = (() => {
  const m = new Map<string, Lang[]>();
  for (const l of LANGS) {
    for (const w of new Set(WORDS[l].split(/\s+/).filter(Boolean))) {
      const list = m.get(w) ?? [];
      list.push(l);
      m.set(w, list);
    }
  }
  return m;
})();

/** Letters only some of the languages use, and what each counts for. */
const LETTERS: [RegExp, Partial<Record<Lang, number>>][] = [
  [/ß/g, { de: 2 }],
  [/[äöü]/g, { de: 0.6 }],
  [/[ñ¿¡]/g, { es: 2 }],
  [/[ãõ]/g, { pt: 2 }],
  [/ç/g, { fr: 0.4, pt: 0.4 }],
  [/[êœîûù]/g, { fr: 0.6 }],
  [/[ìò]/g, { it: 0.8 }],
  [/ij/g, { nl: 0.3 }],
];

/** Lines that start the quoted thread under a reply, in the languages we know. */
const QUOTE_HEADER =
  /^(on .{3,200} wrote:?|le .{3,200} a écrit ?:?|am .{3,200} schrieb .{0,200}|el .{3,200} escribió:?|il .{3,200} ha scritto:?|em .{3,200} escreveu:?|op .{3,200} schreef .{0,200}|-{2,}\s*(original message|message d'origine|ursprüngliche nachricht|mensaje original|messaggio originale|mensagem original|oorspronkelijk bericht)\s*-{2,}|from:\s.+|de\s?:\s.+|von:\s.+|van:\s.+|da:\s.+)$/i;

/** The words of the person's own text: tags, quoted lines, the quoted thread, links and addresses removed. */
export function ownText(raw: string): string {
  const plain = raw
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  const kept: string[] = [];
  for (const line of plain.split(/\r?\n/)) {
    const l = line.trim();
    if (QUOTE_HEADER.test(l)) break;
    if (l.startsWith(">")) continue;
    kept.push(l);
  }
  return kept
    .join("\n")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .slice(0, 5000);
}

export function tokens(text: string): string[] {
  return (text.toLowerCase().replace(/[’`´]/g, "'").match(/\p{L}+(?:'\p{L}+)?/gu) ?? []).flatMap((w) => {
    // "j'ai", "l'imprimante", "don't": keep the whole word (English contractions are listed) and its parts.
    if (!w.includes("'")) return [w];
    const parts = w.split("'");
    return INDEX.has(w) ? [w] : parts;
  });
}

export interface LanguageGuess {
  code: Lang;
  /** The winner's score over the runner-up's (1 = a tie; Infinity = nobody else scored). */
  margin: number;
  scores: Record<Lang, number>;
}

/**
 * The language of a message, or null when it can't tell: fewer than four
 * words, under three points for the best language, or the best not clearly
 * ahead of the next (by a third).
 */
export function detectLanguage(raw: string | null | undefined): LanguageGuess | null {
  if (!raw) return null;
  const text = ownText(raw);
  const words = tokens(text);
  if (words.length < 4) return null;
  const scores = Object.fromEntries(LANGS.map((l) => [l, 0])) as Record<Lang, number>;
  for (const w of words) {
    const langs = INDEX.get(w);
    if (!langs) continue;
    for (const l of langs) scores[l] += 1 / langs.length;
  }
  const lower = text.toLowerCase();
  for (const [re, add] of LETTERS) {
    const n = Math.min(5, (lower.match(re) ?? []).length);
    if (!n) continue;
    for (const [l, w] of Object.entries(add) as [Lang, number][]) scores[l] += n * w;
  }
  const ranked = [...LANGS].sort((a, b) => scores[b] - scores[a]);
  const [best, second] = [scores[ranked[0]], scores[ranked[1]]];
  if (best < 3) return null;
  if (second > 0 && best < second * 1.33) return null;
  return { code: ranked[0], margin: second > 0 ? best / second : Infinity, scores };
}
