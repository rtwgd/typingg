const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeWords() {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    console.log('Navigating to website...');
    await page.goto('https://yamatnt.com/sushida-words/', { waitUntil: 'networkidle0' });

    console.log('Extracting word data...');
    const data = await page.evaluate(() => {
        const courses = [
            { name: 'easy', search: 'お手軽コース', desc: '寿司打お手軽コース (5-7文字)' },
            { name: 'normal', search: 'お勧めコース', desc: '寿司打お勧めコース (7-9文字)' },
            { name: 'hard', search: '高級コース', desc: '寿司打高級コース (9文字以上)' }
        ];

        const result = {};
        const headers = Array.from(document.querySelectorAll('h2, h3'));

        courses.forEach(course => {
            const courseHeader = headers.find(h => h.textContent.includes(course.search));
            if (!courseHeader) {
                result[course.name] = { name: course.name, description: course.desc, list: [] };
                return;
            }

            const list = [];
            let nextNode = courseHeader.nextElementSibling;

            while (nextNode && !courses.some(c => nextNode.textContent.includes(c.search) && (nextNode.tagName === 'H2' || nextNode.tagName === 'H3'))) {
                const tables = nextNode.tagName === 'TABLE' ? [nextNode] : [...nextNode.querySelectorAll('table')];

                tables.forEach(table => {
                    const rows = table.querySelectorAll('tr');
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length >= 2) {
                            const text = cells[0].textContent.trim();
                            const reading = cells[1].textContent.trim();
                            if (text && reading && text !== '単語' && text !== '出題ワード') {
                                list.push({
                                    text: text,
                                    kana: Array.from(reading)
                                });
                            }
                        }
                    });
                });
                nextNode = nextNode.nextElementSibling;
            }

            result[course.name] = {
                name: course.name,
                description: course.desc,
                list: list
            };
        });

        return result;
    });

    await browser.close();

    // Save each course to its file
    const outputDir = __dirname;

    for (const [courseName, courseData] of Object.entries(data)) {
        const filename = path.join(outputDir, `words_${courseName}.json`);
        fs.writeFileSync(filename, JSON.stringify(courseData, null, 4), 'utf8');
        console.log(`Saved ${courseName}: ${courseData.list.length} words to ${filename}`);
    }

    console.log('Done!');
}

scrapeWords().catch(console.error);
