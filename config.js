/*  Конфигурация Пульта.
 *  ВНИМАНИЕ: эти значения видны всем, кто откроет сайт (это нормально для
 *  внутреннего инструмента — защиту на запись даёт серверная проверка роли).
 *
 *  После развёртывания Apps Script вставьте сюда свой Exec URL и API_TOKEN.
 */
window.CONFIG = {
  // Exec URL веб-приложения Apps Script (заканчивается на /exec)
  API_URL: "https://script.google.com/macros/s/AKfycbyubakIHH0XtksroRjDURDg_b9yQDzj6iCkWiA3UHoKKPyXFFuAJyaD5LusKCrgFakl-w/exec",

  // Должен совпадать со Script Property API_TOKEN в Apps Script
  API_TOKEN: "zB_sjBHPF0TMMdZGjLx4Da1ARcMPHmGt67jcY65tL4o",

  // Автообновление данных, мс (0 — выключить)
  POLL_MS: 60000,

  // true  — фото грузятся через прокси Apps Script (надёжно, но медленнее);
  // false — прямой Drive-thumbnail (быстро; требует доступ к файлам «по ссылке»),
  //         при ошибке автоматически падает на прокси.
  PHOTO_VIA_PROXY: false
};
