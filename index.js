const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs-extra');
const path = require('path');

const SYMBOLS_COUNT = 8;
const MULTIPLIERS = [5, 10, 45, 5, 25, 15, 5, 5];
const ICONS = ['☘️', '🦐', '🐟', '🌽', '🥩', '🍗', '🍅', '🥕'];
const NAMES = ['سلطة', 'روبيان', 'سمك', 'ذره', 'استيك', 'دجاج', 'طماطم', 'جزر'];
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
};

function loadSharedData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const data = fs.readJsonSync(DATA_FILE);
            sharedData.allCounts = data.allCounts || Array(SYMBOLS_COUNT).fill(0);
            sharedData.recent = data.recent || [];
            sharedData.totalAll = data.totalAll || 0;
            sharedData.correctPredictions = data.correctPredictions || 0;
            sharedData.totalPredictions = data.totalPredictions || 0;
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
    sharedData.allCounts[symbol] += 1;
    sharedData.recent.push(symbol);
    if (sharedData.recent.length > WINDOW_SIZE) sharedData.recent.shift();
    sharedData.totalAll += 1;
    saveSharedData();
    return true;
}

function resetSharedData() {
    sharedData.allCounts = Array(SYMBOLS_COUNT).fill(0);
    sharedData.recent = [];
    sharedData.totalAll = 0;
    sharedData.correctPredictions = 0;
    sharedData.totalPredictions = 0;
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

function getTop4Symbols() {
    const probs = getLocalProbabilities();
    const indexed = probs.map((p, i) => ({ symbol: i, prob: p }));
    indexed.sort((a, b) => b.prob - a.prob);
    return indexed.slice(0, 4).map(item => item.symbol);
}

function getPredictionKeyboard(topSymbols) {
    const buttons = topSymbols.map(sym => [{
        text: `${ICONS[sym]} ${NAMES[sym]} (${MULTIPLIERS[sym]}x)`,
        callback_data: `pred_${sym}`
    }]);
    buttons.push([{ text: '❌ إجابة خاطئة', callback_data: 'wrong' }]);
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
    const accuracy = sharedData.totalPredictions > 0 ? (sharedData.correctPredictions / sharedData.totalPredictions * 100).toFixed(2) : '0.00';
    let lines = [];
    lines.push('📊 *إحصائيات التعلم*');
    lines.push(`✅ توقعات صحيحة: ${sharedData.correctPredictions}`);
    lines.push(`🔮 إجمالي التوقعات: ${sharedData.totalPredictions}`);
    lines.push(`📈 دقة التوقع: ${accuracy}%\n`);
    lines.push('🎯 *الاحتمالات الحالية*\n');
    for (let i = 0; i < SYMBOLS_COUNT; i++) {
        const icon = ICONS[i];
        const mult = MULTIPLIERS[i];
        const globalP = (globalProbs[i] * 100).toFixed(2);
        const localP = (localProbs[i] * 100).toFixed(2);
        const count = sharedData.allCounts[i];
        lines.push(`${icon} \`${mult}x\` | عام: ${globalP}% | محلي: ${localP}% | مرات: ${count}`);
    }
    lines.push(`\n📊 إجمالي الدورات: ${sharedData.totalAll}`);
    lines.push(`🔄 آخر ${sharedData.recent.length} ضربة في الشريط (الحد الأقصى ${WINDOW_SIZE})`);
    return lines.join('\n');
}

async function sendPrediction(chatId) {
    const topSymbols = getTop4Symbols();
    const keyboard = getPredictionKeyboard(topSymbols);
    const text = '🔮 *توقعاتي للدورة القادمة:*\nاختر الرمز الصحيح إذا كان ضمن الـ 4، أو اضغط "إجابة خاطئة" ثم اختر الرمز الصحيح.';
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
}

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const text = `👋 مرحباً بك في بوت توقعات handhm go!

سأعرض لك كل دورة 4 توقعات (أعلى 4 رموز احتمالاً).
بعد انتهاء الدورة، اضغط على التوقع الصحيح إذا كان ضمن الـ 4،
أو اضغط "❌ إجابة خاطئة" ثم اختر الأيقونة الصحيحة من القائمة.

الأوامر المتاحة:
/stats - عرض الإحصائيات والاحتمالات الحالية
/reset - إعادة تعيين بياناتك
/help - عرض هذه التعليمات

لنبدأ التوقع الأول:`;
    await bot.sendMessage(chatId, text);
    await sendPrediction(chatId);
});

bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 أرسل /start للبدء');
});

bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    const stats = getStatsText();
    bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
});

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'نعم', callback_data: 'reset_confirm' }],
                [{ text: 'لا', callback_data: 'reset_cancel' }],
            ],
        },
    };
    await bot.sendMessage(chatId, 'هل أنت متأكد من مسح كل البيانات المشتركة؟', opts);
});

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    await bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'reset_confirm') {
        resetSharedData();
        await bot.editMessageText('✅ تم مسح البيانات المشتركة بنجاح.', {
            chat_id: chatId,
            message_id: msg.message_id,
        });
        await sendPrediction(chatId);
        return;
    } else if (data === 'reset_cancel') {
        await bot.editMessageText('❌ تم إلغاء عملية المسح.', {
            chat_id: chatId,
            message_id: msg.message_id,
        });
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

console.log('✅ البوت يعمل...');