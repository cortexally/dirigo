// Название модели из строки состояния TUI-агента.
//
// Вынесено из server.ts отдельным модулем, чтобы это можно было проверять
// тестом без поднятия демона: именно здесь легко ошибиться и показать
// пользователю не ту модель, а соврать про модель хуже, чем промолчать.
export function screenModelForTest(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // Разделитель именно «•»: строка состояния «change · Chat: …» использует «·».
  for (const line of lines.slice(-8).reverse()) {
    const m = line.match(/^([A-Za-z][\w.+-]*(?:\s[\w.+-]+){0,4})\s+•\s/);
    if (m && m[1] && m[1].length <= 40) return m[1].trim();
  }
  return null;
}
