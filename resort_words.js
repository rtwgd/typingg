const fs = require('fs');
const path = require('path');

try {
    // Read the file that contains all words (scraper put everything in 'hard')
    const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_hard.json'), 'utf8'));
    const allWords = rawData.list;

    const categorized = {
        easy: [],
        normal: [],
        hard: []
    };

    allWords.forEach(word => {
        // Simple logic for Kana split (just chars)
        // Ideally we should use the same normalization logic as client? 
        // No, client normalizes whatever matches. We just save chars.
        // But let's look at text length as Sushida does.
        const len = word.text.length;

        // Easy: 2-7 chars
        if (len >= 2 && len <= 7) {
            categorized.easy.push({ ...word, kana: splitKana(word.kana) });
        }
        // Normal: 5-10 chars
        if (len >= 5 && len <= 10) {
            categorized.normal.push({ ...word, kana: splitKana(word.kana) });
        }
        // Hard: 9+ chars
        if (len >= 9) {
            categorized.hard.push({ ...word, kana: splitKana(word.kana) });
        }
    });

    function splitKana(kanaArrOrStr) {
        // Scraper might have saved array or string? 
        // Our scraper saved array of chars if split('') was used on string input.
        // But let's ensure it's array of chunks? 
        // Ideally we just save array of chars.
        if (Array.isArray(kanaArrOrStr)) return kanaArrOrStr;
        return kanaArrOrStr.split('');
    }

    const saveFile = (name, list, desc) => {
        const content = {
            name: name,
            description: desc,
            list: list
        };
        fs.writeFileSync(path.join(__dirname, `words_${name}.json`), JSON.stringify(content, null, 4));
        console.log(`Saved words_${name}.json with ${list.length} words`);
    };

    saveFile('easy', categorized.easy, '寿司打お手軽コース (2-7文字)');
    saveFile('normal', categorized.normal, '寿司打お勧めコース (5-10文字)');
    saveFile('hard', categorized.hard, '寿司打高級コース (9文字以上)');

} catch (err) {
    console.error(err);
}
