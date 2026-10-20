// Проверка: почему initProjectRepo не сработал на черновике.
import { initProjectRepo, gitRepoInfo } from "../src/worktrees";

const dir = process.argv[2]!;
console.log("до:", JSON.stringify(gitRepoInfo(dir)));
const r = initProjectRepo(dir);
console.log("initProjectRepo:", JSON.stringify(r));
console.log("после:", JSON.stringify(gitRepoInfo(dir)));
