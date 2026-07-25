#!/usr/bin/env bash
# Vérifie les fichiers qui seraient ajoutés au prochain commit.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

command -v git >/dev/null 2>&1 || {
    echo "ERREUR: git est requis." >&2
    exit 1
}

candidate_list="$(mktemp)"
trap 'rm -f "$candidate_list"' EXIT

git ls-files --cached --others --exclude-standard -z > "$candidate_list"

if [[ ! -s "$candidate_list" ]]; then
    echo "Aucun fichier candidat au commit."
    exit 0
fi

failed=0
max_bytes=$((10 * 1024 * 1024))

while IFS= read -r -d '' file; do
    [[ -f "$file" ]] || continue
    size="$(wc -c < "$file" | tr -d ' ')"
    if (( size > max_bytes )); then
        echo "ERREUR: fichier supérieur à 10 Mio: $file ($size octets)" >&2
        failed=1
    fi
    case "$file" in
        *.pem|*.key|*.p12|*.pfx)
            echo "ERREUR: fichier de clé ou certificat privé potentiel: $file" >&2
            failed=1
            ;;
    esac
done < "$candidate_list"

secret_pattern='AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}'
text_files=()
while IFS= read -r -d '' file; do
    [[ -f "$file" ]] || continue
    if LC_ALL=C grep -Iq . "$file"; then
        text_files+=("$file")
    fi
done < "$candidate_list"

if (( ${#text_files[@]} > 0 )) && rg -n "$secret_pattern" -- "${text_files[@]}"; then
    echo "ERREUR: motif de secret potentiel détecté." >&2
    failed=1
fi

if (( ${#text_files[@]} > 0 )) && rg -n '[[:blank:]]+$' -- "${text_files[@]}"; then
    echo "ERREUR: espaces superflus en fin de ligne." >&2
    failed=1
fi

if (( failed != 0 )); then
    exit 1
fi

echo "Pré-vérification Git réussie."
