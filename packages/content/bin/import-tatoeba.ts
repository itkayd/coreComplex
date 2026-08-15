/** `npm run content:import:tatoeba` — read locally supplied Tatoeba exports. */
import { importTatoeba } from "../src/sources/index.ts";

const report = importTatoeba(process.argv[2] ?? "sources/inbox");
console.log(report.message);
if (!report.installed) process.exit(0);
const withTranslation = report.mandarinSentences.filter((s) => report.translations.has(s.id));
console.log(`Mandarin sentences with an English translation: ${withTranslation.length}`);
console.log("Sentence licences and AUDIO licences remain separate assets;");
console.log(`audio rows lacking their own licence were rejected: ${report.audioRejectedForLicence}`);
