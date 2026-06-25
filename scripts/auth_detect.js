"use strict";

const AUTH_ERROR_MARKERS = [
  "認証されたユーザのみ",
  "認証情報が正しくありません",
  "指定されたURLが間違っている",
  "ページを表示できません",
  "ログインページ"
];

function detectAuthErrorPage(text, html) {
  const haystack = `${text || ""}\n${html || ""}`;
  const marker = AUTH_ERROR_MARKERS.find((item) => haystack.includes(item));
  return {
    detected: Boolean(marker),
    marker: marker || ""
  };
}

module.exports = { detectAuthErrorPage };
