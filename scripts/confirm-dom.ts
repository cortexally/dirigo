// Ответчик на подтверждение в DOM (#oc-confirm) для UI-тестов — вместо
// page.on("dialog"): с 1.9.4 пульт не зовёт window.confirm. Запоминает текст
// диалога и нажимает настоящую кнопку «ok» или «cancel».
import type { Page } from "playwright";

export function answerConfirms(page: Page, decide: (text: string) => "ok" | "cancel"): () => void {
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const el = await page.$("#oc-confirm");
        if (el) {
          const text = (await el.innerText()).trim();
          const answer = decide(text);
          await page.click(`#oc-confirm [data-oc-confirm="${answer}"]`, { timeout: 2000 });
          await page.waitForSelector("#oc-confirm", { state: "detached", timeout: 2000 }).catch(() => null);
        }
      } catch { /* страница закрывается */ }
      await new Promise((r) => setTimeout(r, 80));
    }
  })();
  return () => { stop = true; };
}
