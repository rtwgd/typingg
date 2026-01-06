const fs = require('fs');
const path = require('path');

const files = ['words_easy.json', 'words_normal.json', 'words_hard.json'];

files.forEach(file => {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) return;

    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        let fixedCount = 0;

        data.list = data.list.map(word => {
            if (word.text === '伝説の勇者') {
                // Fix the kana array
                // Correct: ['で', 'ん', 'せ', 'つ', 'の', 'ゆ', 'う', 'し', 'ゃ']
                const correctKana = ['で', 'ん', 'せ', 'つ', 'の', 'ゆ', 'う', 'し', 'ゃ'];
                // Check if broken (has replacement characters or invalid length)
                // The broken one had length 11 with 3 replacement chars
                // Just force overwrite if text matches
                if (JSON.stringify(word.kana) !== JSON.stringify(correctKana)) {
                    word.kana = correctKana;
                    fixedCount++;
                }
            }
            return word;
        });

        if (fixedCount > 0) {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
            console.log(`Fixed ${fixedCount} entries in ${file}`);
        } else {
            console.log(`No broken entries found in ${file}`);
        }

    } catch (err) {
        console.error(`Error processing ${file}:`, err);
    }
});
