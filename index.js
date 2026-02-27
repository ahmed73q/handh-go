const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');

const SYMBOLS_COUNT = 8;
const MULTIPLIERS = [5, 10, 45, 5, 25, 15, 5, 5];
const ICONS = ['☘️', '🦐', '🐟', '🌽', '🥩', '🍗', '🍅', '🥕'];
const NAMES = ['بروكلي', 'روبيان', 'سمك', 'ذره', 'استيك', 'دجاج', 'طماط', 'جزر'];
const WINDOW_SIZE = 29;
const SMOOTHING = 1.0;
const DATA_FILE = path.join(__dirname, 'shared_data.json');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    console.error('❌ لم يتم تعيين TELEGRAM_BOT_TOKEN');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

let sharedData = {
    allCounts: Array(SYMBOLS_COUNT).fill(0),
    recent: [],
    totalAll: 0,
    correctPredictions: 0,
    totalPredictions: 0,
    transitionCounts: Array(SYMBOLS_COUNT).fill().map(() => Array(SYMBOLS_COUNT).fill(0))
};

const userStates = new Map();

function loadSharedData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = fs.readJsonSync(DATA_FILE);
            sharedData.allCounts = data.allCounts || Array(SYMBOLS_COUNT).fill(0);
            sharedData.recent = data.recent || [];
            sharedData.totalAll = data.totalAll || 0;
            sharedData.correctPredictions = data.correctPredictions || 0;
            sharedData.totalPredictions = data.totalPredictions || 0;
            sharedData.transitionCounts = data.transitionCounts || Array(SYMBOLS_COUNT).fill().map(() => Array(SYMBOLS_COUNT).fill(0));
        } catch (e) {
            console.error('خطأ في قراءة ملف البيانات:', e);
        }
    }
}

function saveSharedData() {
    fs.writeJsonSync(DATA_FILE, sharedData, { spaces: 2 });
}

loadSharedData();

function addResult(symbol) {
    if (symbol < 0 || symbol >= SYMBOLS_COUNT) return false;
    
    if (sharedData.recent.length > 0) {
        const last = sharedData.recent[sharedData.recent.length - 1];
        sharedData.transitionCounts[last][symbol] += 1;
    }
    
    sharedData.allCounts[symbol] += 1;
    sharedData.recent.push(symbol);
    if (sharedData.recent.length > WINDOW_SIZE) {
        const removed = sharedData.recent.shift();
    }
    sharedData.totalAll += 1;
    saveSharedData();
    return true;
}

function addMultipleResults(symbols) {
    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        if (sym < 0 || sym >= SYMBOLS_COUNT) continue;
        
        if (i > 0) {
            const prev = symbols[i-1];
            sharedData.transitionCounts[prev][sym] += 1;
        } else if (sharedData.recent.length > 0) {
            const prev = sharedData.recent[sharedData.recent.length - 1];
            sharedData.transitionCounts[prev][sym] += 1;
        }
        
        sharedData.allCounts[sym] += 1;
        sharedData.recent.push(sym);
        if (sharedData.recent.length > WINDOW_SIZE) sharedData.recent.shift();
        sharedData.totalAll += 1;
    }
    saveSharedData();
}

function resetSharedData() {
    sharedData.allCounts = Array(SYMBOLS_COUNT).fill(0);
    sharedData.recent = [];
    sharedData.totalAll = 0;
    sharedData.correctPredictions = 0;
    sharedData.totalPredictions = 0;
    sharedData.transitionCounts = Array(SYMBOLS_COUNT).fill().map(() => Array(SYMBOLS_COUNT).fill(0));
    saveSharedData();
}

function getGlobalProbabilities() {
    const { allCounts, totalAll } = sharedData;
    if (totalAll === 0) return Array(SYMBOLS_COUNT).fill(1 / SYMBOLS_COUNT);
    const smoothed = allCounts.map(c => c + SMOOTHING);
    const sum = smoothed.reduce((a, b) => a + b, 0);
    return smoothed.map(v => v / sum);
}

function getLocalProbabilities() {
    const { recent } = sharedData;
    const n = recent.length;
    if (n === 0) return Array(SYMBOLS_COUNT).fill(1 / SYMBOLS_COUNT);
    const counts = Array(SYMBOLS_COUNT).fill(0);
    recent.forEach(sym => counts[sym]++);
    const smoothed = counts.map(c => c + SMOOTHING);
    const sum = smoothed.reduce((a, b) => a + b, 0);
    return smoothed.map(v => v / sum);
}

function getMarkovProbabilities() {
    if (sharedData.recent.length === 0) {
        return getLocalProbabilities();
    }
    const last = sharedData.recent[sharedData.recent.length - 1];
    const row = sharedData.transitionCounts[last];
    const total = row.reduce((a, b) => a + b, 0);
    if (total === 0) {
        return getLocalProbabilities();
    }
    const smoothed = row.map(c => c + SMOOTHING);
    const sum = smoothed.reduce((a, b) => a + b, 0);
    return smoothed.map(v => v / sum);
}

function getTop3Symbols() {
    const probs = getMarkovProbabilities();
    const indexed = probs.map((p, i) => ({ symbol: i, prob: p }));
    indexed.sort((a, b) => b.prob - a.prob);
    return indexed.slice(0, 3).map(item => item.symbol);
}

function getPredictionKeyboard(topSymbols) {
    const buttons = topSymbols.map(sym => [{
        text: `${ICONS[sym]} ${NAMES[sym]} (${MULTIPLIERS[sym]}x)`,
        callback_data: `pred_${sym}`
    }]);
    buttons.push([{ text: '❌ إجابة خاطئة', callback_data: 'wrong' }]);
    buttons.push([{ text: '📊 إرسال الشريط', callback_data: 'send_strip' }]);
    return { inline_keyboard: buttons };
}

function getAllSymbolsKeyboard() {
    const buttons = [];
    for (let i = 0; i < SYMBOLS_COUNT; i++) {
        buttons.push([{
            text: `${ICONS[i]} ${NAMES[i]} (${MULTIPLIERS[i]}x)`,
            callback_data: `correct_${i}`
        }]);
    }
    return { inline_keyboard: buttons };
}

function getStatsText() {
    const globalProbs = getGlobalProbabilities();
    const localProbs = getLocalProbabilities();
    const markovProbs = getMarkovProbabilities();
    const accuracy = sharedData.totalPredictions > 0 ? (sharedData.correctPredictions / sharedData.totalPredictions * 100).toFixed(2) : '0.00';
    let lines = [];
    lines.push('📊 *إحصائيات التعلم*');
    lines.push(`✅ توقعات صحيحة: ${sharedData.correctPredictions}`);
    lines.push(`🔮 إجمالي التوقعات: ${sharedData.totalPredictions}`);
    lines.push(`📈 دقة التوقع: ${accuracy}%\n`);
    lines.push('🎯 *الاحتمالات الحالية (ماركوف)*\n');
    for (let i = 0; i < SYMBOLS_COUNT; i++) {
        const icon = ICONS[i];
        const mult = MULTIPLIERS[i];
        const markovP = (markovProbs[i] * 100).toFixed(2);
        const count = sharedData.allCounts[i];
        lines.push(`${icon} \`${mult}x\` | ماركوف: ${markovP}% | مرات: ${count}`);
    }
    lines.push('\n📊 *مقارنة مع الاحتمالات العامة والمحلية*\n');
    for (let i = 0; i < SYMBOLS_COUNT; i++) {
        const icon = ICONS[i];
        const mult = MULTIPLIERS[i];
        const globalP = (globalProbs[i] * 100).toFixed(2);
        const localP = (localProbs[i] * 100).toFixed(2);
        lines.push(`${icon} \`${mult}x\` | عام: ${globalP}% | محلي: ${localP}%`);
    }
    lines.push(`\n📊 إجمالي الدورات: ${sharedData.totalAll}`);
    lines.push(`🔄 آخر ${sharedData.recent.length} ضربة في الشريط (الحد الأقصى ${WINDOW_SIZE})`);
    return lines.join('\n');
}

function getSymbolsGuide() {
    let guide = '🔢 *الأرقام المخصصة لكل رمز:*\n';
    for (let i = 0; i < SYMBOLS_COUNT; i++) {
        guide += `${i} : ${ICONS[i]} ${NAMES[i]} (${MULTIPLIERS[i]}x)\n`;
    }
    return guide;
}

async function sendPrediction(chatId) {
    const topSymbols = getTop3Symbols();
    const keyboard = getPredictionKeyboard(topSymbols);
    const text = '🔮 *توقعاتي للدورة القادمة (باستخدام نموذج ماركوف):*\nاختر الرمز الصحيح إذا كان ضمن الـ 3، أو اضغط "إجابة خاطئة" ثم اختر الرمز الصحيح.';
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

function parseNumbersFromText(text) {
    const regex = /[0-7]/g;
    const matches = text.match(regex);
    if (!matches) return [];
    return matches.map(m => parseInt(m, 10));
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const guide = getSymbolsGuide();
    const text = `👋 مرحباً بك في بوت توقعات handhm go (نسخة ماركوف)!

${guide}

سأعرض لك كل دورة 3 توقعات بناءً على آخر رمز ظهر (نموذج ماركوف من الدرجة الأولى).
بعد انتهاء الدورة، يمكنك:
- الضغط على التوقع الصحيح إذا كان ضمن الـ 3.
- الضغط على "❌ إجابة خاطئة" ثم اختيار الرمز الصحيح من القائمة.
- الضغط على "📊 إرسال الشريط" لإدخال آخر 29 نتيجة دفعة واحدة (أرسل 29 رقماً من 0 إلى 7).

الأوامر المتاحة:
/stats - عرض الإحصائيات والاحتمالات الحالية
/help - عرض هذه التعليمات

لنبدأ التوقع الأول:`;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    await sendPrediction(chatId);
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const guide = getSymbolsGuide();
    const text = `👋 *مساعدة البوت*

${guide}

يعتمد البوت على نموذج ماركوف من الدرجة الأولى (الاعتماد على آخر رمز فقط) لتوقع الرمز القادم.
يمكنك التفاعل عبر الأزرار الموجودة في رسالة التوقع.
الأوامر النصية:
/stats - عرض الإحصائيات الحالية
/start - إعادة تشغيل البوت

عند الضغط على "📊 إرسال الشريط"، أرسل 29 رقماً (0-7) متتالية أو مفصولة بمسافات.`;
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    const stats = getStatsText();
    bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    await bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'send_strip') {
        userStates.set(chatId, { awaitingStrip: true });
        await bot.sendMessage(chatId, '📥 الرجاء إرسال 29 رقمًا (0-7) تمثل آخر 29 نتيجة في الشريط، مفصولة بمسافات أو بدون فواصل (مثال: 2 5 1 0 3 7 4 6 ...).');
        return;
    }

    if (data.startsWith('pred_')) {
        const symbol = parseInt(data.split('_')[1]);
        sharedData.correctPredictions += 1;
        sharedData.totalPredictions += 1;
        saveSharedData();
        await bot.editMessageText(`✅ صحيح! الرمز ${ICONS[symbol]} كان ضمن توقعاتي.`, {
            chat_id: chatId,
            message_id: msg.message_id,
        });
        addResult(symbol);
        await sendPrediction(chatId);
    }
    else if (data === 'wrong') {
        const keyboard = getAllSymbolsKeyboard();
        await bot.editMessageText('❌ اختر الرمز الصحيح من القائمة:', {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: keyboard,
        });
    }
    else if (data.startsWith('correct_')) {
        const symbol = parseInt(data.split('_')[1]);
        sharedData.totalPredictions += 1;
        saveSharedData();
        await bot.editMessageText(`✅ تم تسجيل الرمز الصحيح: ${ICONS[symbol]}.`, {
            chat_id: chatId,
            message_id: msg.message_id,
        });
        addResult(symbol);
        await sendPrediction(chatId);
    }
});

bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text.startsWith('/')) return;

    if (userStates.has(chatId) && userStates.get(chatId).awaitingStrip) {
        const numbers = parseNumbersFromText(text);
        if (numbers.length === 29) {
            addMultipleResults(numbers);
            userStates.delete(chatId);
            await bot.sendMessage(chatId, `✅ تم تسجيل ${numbers.length} نتيجة بنجاح. تم تحديث البيانات.`);
            const stats = getStatsText();
            await bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
            await sendPrediction(chatId);
        } else {
            await bot.sendMessage(chatId, `❌ العدد غير صحيح. يجب أن ترسل 29 رقماً بالضبط. لقد أرسلت ${numbers.length}. حاول مرة أخرى:`);
        }
        return;
    }

    const numbers = parseNumbersFromText(text);
    if (numbers.length > 1) {
        addMultipleResults(numbers);
        await bot.sendMessage(chatId, `✅ تم تسجيل ${numbers.length} نتيجة بنجاح.`);
        const stats = getStatsText();
        await bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
        await sendPrediction(chatId);
    }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running');
}).listen(PORT, () => {
    console.log(`🚀 خادم وهمي يستمع على المنفذ ${PORT}`);
});

console.log('✅ البوت يعمل بنموذج ماركوف...');
