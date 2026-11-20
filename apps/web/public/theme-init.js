// Chạy TRƯỚC khi React tải (thẻ <script> chặn trong <head>) để không nháy sai theme/ngôn ngữ.
// File tĩnh (không inline) để tương thích CSP chặt. Đồng bộ khóa với src/shared/theme và src/shared/i18n.
(function () {
  var theme = 'system';
  var lang = 'vi';
  try {
    theme = localStorage.getItem('itso.theme') || 'system';
    lang = localStorage.getItem('itso.lang') || 'vi';
  } catch (e) {
    /* storage bị chặn: dùng mặc định */
  }
  var dark =
    theme === 'dark' ||
    (theme !== 'light' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.lang = lang === 'en' ? 'en' : 'vi';
})();
