// Отправка SMS. Если SMS_API_URL не задан в .env — код печатается в консоль сервера
// (режим разработки, чтобы можно было тестировать сброс пароля без реального провайдера).
//
// Чтобы подключить настоящий SMS-шлюз (Mobizon, SMSC.kz, Twilio и т.п.):
// 1. Зарегистрируйтесь у провайдера, получите API-ключ и URL для отправки
// 2. Впишите SMS_API_URL / SMS_API_KEY / SMS_SENDER в .env
// 3. Приведите тело запроса ниже в соответствие формату именно вашего провайдера —
//    у каждого он свой, унифицированного стандарта нет.

async function sendSms(phone, text) {
  const url = process.env.SMS_API_URL;
  const apiKey = process.env.SMS_API_KEY;

  if (!url || !apiKey) {
    console.log(`\n[SMS не настроен — режим разработки]\nКому: ${phone}\nТекст: ${text}\n`);
    return { simulated: true };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      to: phone,
      from: process.env.SMS_SENDER || "Kassa",
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Не удалось отправить SMS: ${res.status} ${body}`);
  }
  return res.json().catch(() => ({}));
}

module.exports = { sendSms };
