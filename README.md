# 7tv-for-youtube
# 7TV for YouTube (Unofficial) 7TV для YouTube (Неофициально)

# КАЧАТЬ ЧЕРЕЗ [РЕЛИЗЫ](https://github.com/syocless/7tv-for-youtube/releases)
# DOWNLOAD CLICK ON [RELEASES](https://github.com/syocless/7tv-for-youtube/releases) 
# НАБОР СМАЙЛИКОВ Olesha Ent. https://7tv.app/emote-sets/01FEGJ99QR000AENY3GSAKBAHP
# Люди которые внесли вклад ❤️ Eargosha Overbacon

7TV для YouTube (Неофициально)
Расширение для браузера, которое добавляет 7TV-смайлики в YouTube Live Chat.
Расширение автоматически загружает глобальные смайлики 7TV и позволяет добавлять дополнительные наборы смайликов — например, набор конкретного стримера или личный набор
Проект не связан официально с 7TV, Twitch или YouTube.
Что умеет расширение:
- Автоматически загружает глобальный набор смайликов 7TV.
- Позволяет добавлять дополнительные наборы смайликов.
- Поддерживает наборы конкретных каналов и личные наборы.
- Автоматически заменяет названия 7TV-смайликов в YouTube Live Chat на изображения.
- Смайлики появляются непосредственно во время общения в чате.

# Установка Chrome / Edge / Brave
1. Скачайте и распакуйте "7tv-for-youtube-chrome.zip".
2. Откройте в браузере страницу:   
   "chrome://extensions"
3. В правом верхнем углу включите Режим разработчика (Developer mode).
4. Нажмите Load unpacked / Загрузить распакованное расширение.
5. Выберите папку с распакованным расширением.
6. После установки откройте YouTube и перейдите на любую трансляцию с Live Chat.

# Установка Firefox
1. Скачайте и распакуйте "7tv-for-youtube-firefox.zip".
2. Откройте:
   "about:debugging#/runtime/this-firefox"
4. Откройте "Этот Firefox"
4. Нажмите Load Temporary Add-on/Загрузить временное дополнение
5. Выберите файл "manifest.json" внутри распакованной папки.
6. Обратите внимание: временное расширение удаляется после перезапуска Firefox.

Как добавить дополнительные смайлики
Чтобы добавить смайлики конкретного канала или свой набор:
1. Нажмите на значок Расширения в браузере.
2. Найдите 7TV for YouTube.
3. Откройте Popup / всплывающее окно расширения.
4. Скопируйте ссылку на нужный набор смайликов 7TV.
5. Вставьте ссылку в поле в Popup.
6. Сохраните/добавьте набор.
7. После этого смайлики из набора будут доступны в YouTube Live Chat.
Важно: ссылка должна вести именно на набор смайликов и содержать "/emote-sets/".
Правильно:
"https://7tv.app/emote-sets/..."
Неправильно:
"https://7tv.app/users/..."
Можно добавить несколько наборов, разделив ссылки запятыми. Если добавляете личный набор, рекомендуется указать его последним — тогда его названия будут иметь приоритет при совпадениях
Ограничения:
- Смайлики будут видны только пользователям, у которых также установлено это расширение.
- Расширение не может сделать смайлики видимыми для всех зрителей YouTube.
- У 7TV нет единой библиотеки «скачать всё», поэтому необходимые наборы добавляются отдельно.
- Расширение зависит от текущей структуры YouTube Live Chat. Если YouTube изменит её, расширение может перестать работать до выхода обновления.
- Для получения данных используется публичный, но официально недокументированный API 7TV "7tv.io/v3", поэтому его работа может измениться или быть ограничена без предупреждения.


Renders 7TV emotes inside YouTube Live Chat. Unofficial and not affiliated
with 7TV, Twitch, or YouTube — built because 7TV doesn't support YouTube yet.

## What it does

- Loads the 7TV global emote set automatically.
- Lets you add extra emote sets (a streamer's channel set, your own
  personal set) by pasting their 7tv.app links in the popup.
- Watches YouTube's live chat and swaps matching emote names for images,
  live, as messages come in.

## Limitations (read before installing)

- Only visible to people who also install this extension — it can't make
  emotes appear for viewers who don't have it.
- 7TV has no single "download everything" library; you build your own
  emote list by adding specific channels' set IDs.
- Relies on YouTube's current chat DOM structure. If YouTube changes it,
  the extension may stop working until updated.
- Uses 7TV's public but undocumented 7tv.io/v3 API — this could change
  or rate-limit without notice.

## Install — Chrome / Edge / Brave (Chromium)

1. Download and unzip 7tv-for-youtube-chrome.zip.
2. Go to chrome://extensions.
3. Enable Developer mode (top right).
4. Click Load unpacked and select the unzipped folder.
5. Open the extension's popup icon to optionally add extra emote sets.

## Install — Firefox

1. Download and unzip 7tv-for-youtube-firefox.zip.
2. Go to about:debugging#/runtime/this-firefox.
3. Click Load Temporary Add-on and select manifest.json inside the
   unzipped folder.
4. Note: temporary add-ons are removed when Firefox restarts. For a
   permanent install, submit the same folder for signing at
   [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
   (unlisted distribution keeps it private, doesn't require public review).

## Adding more emotes

Open the extension popup and paste a 7tv.app emote set link (the URL
must contain /emote-sets/, not /users/) — a channel page, comma-separate
multiple. Put your own personal set last so its names win on conflicts.
# Adding emote sets
- Open the browser's Extensions menu.
- Find 7TV for YouTube.
- Open the extension Popup.
- Paste your 7TV emote-set link into the field.
- Add/save the set.
The URL must contain:
/emote-sets/
Do not use /users/.
Multiple emote-set links can be added, separated by commas.
Important
Only users who have the extension installed will see the 7TV emotes. The extension is unofficial and is not affiliated with 7TV, Twitch, or YouTube.

## License

MIT — see LICENSE.
