/*  Конфигурация Пульта.
 *  ВНИМАНИЕ: эти значения видны всем, кто откроет сайт (это нормально для
 *  внутреннего инструмента — защиту на запись даёт серверная проверка роли).
 *
 *  Настраивать ничего не нужно: API_TOKEN уже совпадает с DEFAULTS в Code.gs.
 *  Менять его нужно только после rotateSecrets() (тогда взять новый из «Логов»
 *  Apps Script). Exec URL — из «Развернуть → Управление развёртываниями».
 */
window.CONFIG = {
  // Exec URL веб-приложения Apps Script (заканчивается на /exec)
  API_URL: "https://script.google.com/macros/s/AKfycbyubakIHH0XtksroRjDURDg_b9yQDzj6iCkWiA3UHoKKPyXFFuAJyaD5LusKCrgFakl-w/exec",

  // Совпадает с DEFAULTS.API_TOKEN в Code.gs (после rotateSecrets() — заменить)
  API_TOKEN: "jW-zxLbZfocATo_8s4F0G2qn4MV4htxLlaTW-D3g1k4",

  // Автообновление данных, мс (0 — выключить).
  // 240000 = 4 минуты: при ~5000 строк каждый опрос — это ~2–3 МБ трафика
  // и полное чтение таблицы на сервере; для ручного обновления есть кнопка
  // и pull-to-refresh.
  POLL_MS: 240000,

  // true  — фото грузятся через прокси Apps Script (надёжно, но медленнее);
  // false — прямой Drive-thumbnail (быстро; требует доступ к файлам «по ссылке»),
  //         при ошибке автоматически падает на прокси.
  PHOTO_VIA_PROXY: false
};
