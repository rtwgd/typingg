const https = require('https');
const fs = require('fs');
const path = require('path');

const URL = 'https://yamatnt.com/sushida-words/';

function fetchHTML(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', (err) => reject(err));
        });
    });
}

function parseHTML(html) {
    // Determine sections by finding headers
    // Using simple string searching to avoid complex regex failing on large HTML
    const markers = {
        easy: 'お手軽コース',
        normal: 'お勧めコース',
        hard: '高級コース',
        end: '関連記事'
    };

    // Find indices
    const idxEasy = html.indexOf(markers.easy);
    const idxNormal = html.indexOf(markers.normal);
    const idxHard = html.indexOf(markers.hard);
    // Find end marker specifically after hard section to avoid false positives
    const idxEnd = html.indexOf(markers.end, idxHard);

    if (idxEasy === -1 || idxNormal === -1 || idxHard === -1) {
        throw new Error('Course headers not found');
    }

    const sections = {
        easy: html.substring(idxEasy, idxNormal),
        normal: html.substring(idxNormal, idxHard),
        hard: html.substring(idxHard, idxEnd !== -1 ? idxEnd : html.length)
    };

    const result = { easy: [], normal: [], hard: [] };

    for (const [key, content] of Object.entries(sections)) {
        // Find all rows
        // Regex for <tr><td>TEXT</td><td>KANA</td>...</tr>
        // Be careful with newlines and attributes
        // Use a regex that matches <td> content non-greedily
        const rowRegex = /<tr>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>/g;
        let match;

        // Skip the first row usually (header), but regex might hit headers if they are td.
        // Sushida site tables: <td>ワード</td><td>読み仮名</td> (header row might be th?)
        // Let's just filter out rows where kana matches "読み仮名"

        while ((match = rowRegex.exec(content)) !== null) {
            const text = match[1].replace(/<[^>]*>/g, '').trim(); // Remove tags if any
            const kana = match[2].replace(/<[^>]*>/g, '').trim();

            if (kana !== '読み仮名' && kana !== 'ー' && text) {
                // Split kana into chars for JSON format
                result[key].push({
                    text: text,
                    kana: kana.split('')
                });
            }
        }
    }
    return result;
}

async function main() {
    try {
        console.log('Fetching HTML...');
        const html = await fetchHTML(URL);
        console.log('Parsing HTML...');
        const data = parseHTML(html);

        console.log(`Extracted: Easy(${data.easy.length}), Normal(${data.normal.length}), Hard(${data.hard.length})`);

        // Save to files
        const saveFile = (name, list, desc) => {
            const content = {
                name: name,
                description: desc,
                list: list
            };
            fs.writeFileSync(path.join(__dirname, `words_${name}.json`), JSON.stringify(content, null, 4));
            console.log(`Saved words_${name}.json`);
        };

        // Japanese names for JSON
        saveFile('easy', data.easy, '寿司打お手軽コース (2-7文字)');
        saveFile('normal', data.normal, '寿司打お勧めコース (5-10文字)');
        saveFile('hard', data.hard, '寿司打高級コース (9文字以上)');

    } catch (err) {
        console.error('Error:', err);
    }
}

main();
