#!/usr/bin/env bash
# একবার চালালেই Hind Siliguri (বাংলা) ফন্ট public/ ফোল্ডারে নেমে যাবে। নেট লাগবে।
set -e
cd "$(dirname "$0")"
UA="Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
css=$(curl -fsSA "$UA" "https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600")
for w in 400 600; do
  url=$(printf '%s' "$css" | awk -v RS='}' -v w="$w" '$0 ~ /\/\* bengali \*\// && $0 ~ ("font-weight: " w ";") { if (match($0, /https:[^)]*\.woff2/)) { print substr($0, RSTART, RLENGTH); exit } }')
  [ -n "$url" ] || { echo "ফন্টের লিংক পাওয়া যায়নি (weight $w)"; exit 1; }
  curl -fsSo "public/hind-bn-$w.woff2" "$url"
  echo "নামানো হয়েছে: public/hind-bn-$w.woff2 ($(wc -c < public/hind-bn-$w.woff2) bytes)"
done
