// WhatsApp Ordering System v3.1 — Cloudflare Worker (MPM Catalog + Razorpay UPI)
// Handles: webhook verification, message processing, state machine, dashboard API, payment callbacks
// Target: HKP Road businesses — exclusive delivery with 2 free chai on first order
// Uses Meta Commerce Catalog + Multi-Product Messages for native cart with quantity selector
// Payment: COD (instant confirm) or UPI via Razorpay Payment Links

// ── Product catalog mapping: retailer_id → Odoo product + price ──
const CATALOG_ID = '1986268632293641';

const PRODUCTS = {
  'NCH-IC':  { name: 'Irani Chai',            price: 15,  odooId: 1028 },
  'NCH-NSC': { name: 'Nawabi Special Coffee',  price: 30,  odooId: 1102 },
  'NCH-LT':  { name: 'Lemon Tea',             price: 20,  odooId: 1103 },
  'NCH-BM':  { name: 'Bun Maska',             price: 40,  odooId: 1029 },
  'NCH-OB3': { name: 'Osmania Biscuit x3',    price: 20,  odooId: 1033 },
  'NCH-CC':  { name: 'Chicken Cutlet',        price: 25,  odooId: 1031 },
};

const NCH_LAT = 12.9868674;
const NCH_LNG = 77.6044311;
const MAX_DELIVERY_RADIUS_M = 600;
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

const RUNNERS = ['FAROOQ', 'AMIN', 'NCH Runner 03', 'NCH Runner 04', 'NCH Runner 05'];

const BIZ_CATEGORIES = [
  { id: 'biz_shop', title: 'Shop / Retail' },
  { id: 'biz_restaurant', title: 'Restaurant / Café' },
  { id: 'biz_office', title: 'Office / Other' },
];

// ── Language Support ──
const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'hi', name: 'Hindi', native: 'हिंदी' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
];

// Translation strings for all user-facing text
const T = {
  // ── Greeting & Welcome ──
  welcome_back: {
    en: (name) => `Welcome back${name ? ' ' + name : ''}! *Nawabi Chai House* here.`,
    ur: (name) => `خوش آمدید${name ? ' ' + name : ''}! *نوابی چائے ہاؤس*`,
    hi: (name) => `वापस स्वागत है${name ? ' ' + name : ''}! *नवाबी चाय हाउस*`,
    kn: (name) => `ಮರಳಿ ಸ್ವಾಗತ${name ? ' ' + name : ''}! *ನವಾಬಿ ಚಾಯ್ ಹೌಸ್*`,
    ta: (name) => `மீண்டும் வரவேற்கிறோம்${name ? ' ' + name : ''}! *நவாபி சாய் ஹவுஸ்*`,
  },
  your_last_order: {
    en: 'Your last order:', ur: 'آپ کا آخری آرڈر:', hi: 'आपका पिछला ऑर्डर:',
    kn: 'ನಿಮ್ಮ ಕೊನೆಯ ಆರ್ಡರ್:', ta: 'உங்கள் கடைசி ஆர்டர்:',
  },
  delivering_to: {
    en: '📍 Delivering to:', ur: '📍 ڈلیوری:', hi: '📍 डिलीवरी:', kn: '📍 ಡೆಲಿವರಿ:', ta: '📍 டெலிவரி:',
  },
  new_user_greeting: {
    en: `*☕ Nawabi Chai House — HKP Road, Shivajinagar*\n\nFresh Irani Chai & snacks delivered to your doorstep in 5 minutes!\n\n🎁 *Exclusive for HKP Road businesses:*\nYour first *2 Irani Chai are FREE!*\n\nTo get started, what type of business are you with?`,
    ur: `*☕ نوابی چائے ہاؤس — HKP روڈ، شیواجی نگر*\n\nتازہ ایرانی چائے اور ناشتہ 5 منٹ میں آپ کی دہلیز پر!\n\n🎁 *HKP روڈ کے کاروبار کے لیے خاص:*\nآپ کی پہلی *2 ایرانی چائے مفت!*\n\nشروع کرنے کے لیے، آپ کا کاروبار کیا ہے؟`,
    hi: `*☕ नवाबी चाय हाउस — HKP रोड, शिवाजीनगर*\n\nताज़ी ईरानी चाय और नाश्ता 5 मिनट में आपके दरवाज़े पर!\n\n🎁 *HKP रोड व्यापारियों के लिए ख़ास:*\nपहली *2 ईरानी चाय मुफ़्त!*\n\nशुरू करने के लिए, आपका बिज़नेस क्या है?`,
    kn: `*☕ ನವಾಬಿ ಚಾಯ್ ಹೌಸ್ — HKP ರೋಡ್, ಶಿವಾಜಿನಗರ*\n\nತಾಜಾ ಇರಾನಿ ಚಾಯ್ ಮತ್ತು ತಿಂಡಿ 5 ನಿಮಿಷದಲ್ಲಿ ನಿಮ್ಮ ಬಾಗಿಲಿಗೆ!\n\n🎁 *HKP ರೋಡ್ ವ್ಯಾಪಾರಿಗಳಿಗೆ ವಿಶೇಷ:*\nಮೊದಲ *2 ಇರಾನಿ ಚಾಯ್ ಉಚಿತ!*\n\nಪ್ರಾರಂಭಿಸಲು, ನಿಮ್ಮ ವ್ಯಾಪಾರ ಯಾವುದು?`,
    ta: `*☕ நவாபி சாய் ஹவுஸ் — HKP ரோடு, சிவாஜிநகர்*\n\nபுதிய இரானி சாய் மற்றும் சிற்றுண்டி 5 நிமிடத்தில் உங்கள் வாசலில்!\n\n🎁 *HKP ரோடு வணிகர்களுக்கு சிறப்பு:*\nமுதல் *2 இரானி சாய் இலவசம்!*\n\nதொடங்க, உங்கள் வணிகம் என்ன?`,
  },
  // ── Language Selection ──
  choose_language: {
    en: '🌐 *Choose your language*\nSelect your preferred language for ordering:',
    ur: '🌐 *اپنی زبان منتخب کریں*\nآرڈر کرنے کے لیے اپنی پسندیدہ زبان منتخب کریں:',
    hi: '🌐 *अपनी भाषा चुनें*\nऑर्डर करने के लिए अपनी पसंदीदा भाषा चुनें:',
    kn: '🌐 *ನಿಮ್ಮ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಿ*\nಆರ್ಡರ್ ಮಾಡಲು ನಿಮ್ಮ ಆದ್ಯತೆಯ ಭಾಷೆಯನ್ನು ಆಯ್ಕೆ ಮಾಡಿ:',
    ta: '🌐 *உங்கள் மொழியை தேர்ந்தெடுக்கவும்*\nஆர்டர் செய்ய உங்கள் விருப்பமான மொழியைத் தேர்ந்தெடுக்கவும்:',
  },
  language_saved: {
    en: (lang) => `✅ Language set to *${lang}*!`,
    ur: (lang) => `✅ زبان *${lang}* پر سیٹ ہو گئی!`,
    hi: (lang) => `✅ भाषा *${lang}* पर सेट हो गई!`,
    kn: (lang) => `✅ ಭಾಷೆ *${lang}* ಗೆ ಹೊಂದಿಸಲಾಗಿದೆ!`,
    ta: (lang) => `✅ மொழி *${lang}* என அமைக்கப்பட்டது!`,
  },
  // ── Business Type ──
  select_biz_type: {
    en: 'To get started, what type of business are you with?',
    ur: 'شروع کرنے کے لیے، آپ کا کاروبار کیا ہے؟',
    hi: 'शुरू करने के लिए, आपका बिज़नेस क्या है?',
    kn: 'ಪ್ರಾರಂಭಿಸಲು, ನಿಮ್ಮ ವ್ಯಾಪಾರ ಯಾವುದು?',
    ta: 'தொடங்க, உங்கள் வணிகம் என்ன?',
  },
  great_whats_your_name: {
    en: "Great! What's your name?", ur: 'بہت اچھا! آپ کا نام کیا ہے؟',
    hi: 'बढ़िया! आपका नाम क्या है?', kn: 'ಒಳ್ಳೆಯದು! ನಿಮ್ಮ ಹೆಸರು ಏನು?',
    ta: 'நல்லது! உங்கள் பெயர் என்ன?',
  },
  type_name_to_continue: {
    en: 'Please type your name to continue.', ur: 'جاری رکھنے کے لیے اپنا نام لکھیں۔',
    hi: 'जारी रखने के लिए अपना नाम लिखें।', kn: 'ಮುಂದುವರಿಸಲು ನಿಮ್ಮ ಹೆಸರನ್ನು ಟೈಪ್ ಮಾಡಿ.',
    ta: 'தொடர உங்கள் பெயரை தட்டச்சு செய்யுங்கள்.',
  },
  // ── Location ──
  share_location: {
    en: (name) => `Welcome ${name}! 📍 Please share your location so we can deliver to you.`,
    ur: (name) => `خوش آمدید ${name}! 📍 براہ کرم اپنا مقام شیئر کریں تاکہ ہم آپ تک ڈلیوری کر سکیں۔`,
    hi: (name) => `स्वागत है ${name}! 📍 कृपया अपना लोकेशन शेयर करें ताकि हम डिलीवर कर सकें।`,
    kn: (name) => `ಸ್ವಾಗತ ${name}! 📍 ದಯವಿಟ್ಟು ನಿಮ್ಮ ಸ್ಥಳವನ್ನು ಹಂಚಿಕೊಳ್ಳಿ.`,
    ta: (name) => `வரவேற்கிறோம் ${name}! 📍 டெலிவரி செய்ய உங்கள் இருப்பிடத்தை பகிரவும்.`,
  },
  share_location_generic: {
    en: '📍 Please share your delivery location using the attach (📎) button → Location',
    ur: '📍 براہ کرم اٹیچ (📎) بٹن → لوکیشن سے اپنا مقام شیئر کریں',
    hi: '📍 कृपया अटैच (📎) बटन → लोकेशन से अपना लोकेशन शेयर करें',
    kn: '📍 ದಯವಿಟ್ಟು ಅಟ್ಯಾಚ್ (📎) ಬಟನ್ → ಲೊಕೇಶನ್ ಬಳಸಿ ಹಂಚಿಕೊಳ್ಳಿ',
    ta: '📍 இணைப்பு (📎) பொத்தான் → இருப்பிடம் மூலம் பகிரவும்',
  },
  share_new_location: {
    en: '📍 Share your new delivery location:',
    ur: '📍 اپنا نیا ڈلیوری مقام شیئر کریں:',
    hi: '📍 अपना नया डिलीवरी लोकेशन शेयर करें:',
    kn: '📍 ನಿಮ್ಮ ಹೊಸ ಡೆಲಿವರಿ ಸ್ಥಳವನ್ನು ಹಂಚಿಕೊಳ್ಳಿ:',
    ta: '📍 உங்கள் புதிய டெலிவரி இருப்பிடத்தை பகிரவும்:',
  },
  out_of_range: {
    en: (dist) => `😔 Sorry, you're *${dist}* away. We currently deliver only along *HKP Road, Shivajinagar*.\n\nVisit us at the shop — we'd love to see you! ☕`,
    ur: (dist) => `😔 معذرت، آپ *${dist}* دور ہیں۔ ہم فی الحال صرف *HKP روڈ، شیواجی نگر* پر ڈلیوری کرتے ہیں۔\n\nہماری دکان پر آئیں! ☕`,
    hi: (dist) => `😔 सॉरी, आप *${dist}* दूर हैं। हम फ़िलहाल सिर्फ़ *HKP रोड, शिवाजीनगर* पर डिलीवर करते हैं।\n\nहमारी दुकान पर आइए! ☕`,
    kn: (dist) => `😔 ಕ್ಷಮಿಸಿ, ನೀವು *${dist}* ದೂರದಲ್ಲಿದ್ದೀರಿ. ನಾವು ಪ್ರಸ್ತುತ *HKP ರೋಡ್, ಶಿವಾಜಿನಗರ* ಮಾತ್ರ ಡೆಲಿವರಿ ಮಾಡುತ್ತೇವೆ.\n\nನಮ್ಮ ಅಂಗಡಿಗೆ ಬನ್ನಿ! ☕`,
    ta: (dist) => `😔 மன்னிக்கவும், நீங்கள் *${dist}* தொலைவில் உள்ளீர்கள். நாங்கள் தற்போது *HKP ரோடு, சிவாஜிநகர்* மட்டுமே டெலிவரி செய்கிறோம்.\n\nஎங்கள் கடைக்கு வாருங்கள்! ☕`,
  },
  location_is_correct: {
    en: '✅ Location is correct', ur: '✅ مقام درست ہے', hi: '✅ लोकेशन सही है',
    kn: '✅ ಸ್ಥಳ ಸರಿಯಾಗಿದೆ', ta: '✅ இருப்பிடம் சரி',
  },
  // ── Menu ──
  browse_menu: {
    en: 'Browse our menu, pick what you like, and send your order 👇',
    ur: 'ہمارا مینو دیکھیں، پسند کریں، اور آرڈر بھیجیں 👇',
    hi: 'हमारा मेनू देखें, पसंद करें, और ऑर्डर भेजें 👇',
    kn: 'ನಮ್ಮ ಮೆನು ನೋಡಿ, ಆಯ್ಕೆ ಮಾಡಿ, ಮತ್ತು ಆರ್ಡರ್ ಕಳುಹಿಸಿ 👇',
    ta: 'எங்கள் மெனுவைப் பாருங்கள், தேர்வு செய்து ஆர்டர் அனுப்புங்கள் 👇',
  },
  browse_menu_free_chai: {
    en: (name) => `Thanks ${name}!\n\n🎁 *Your first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`,
    ur: (name) => `شکریہ ${name}!\n\n🎁 *آپ کی پہلی 2 ایرانی چائے مفت!*\n\nہمارا مینو دیکھیں 👇`,
    hi: (name) => `धन्यवाद ${name}!\n\n🎁 *आपकी पहली 2 ईरानी चाय मुफ़्त!*\n\nहमारा मेनू देखें 👇`,
    kn: (name) => `ಧನ್ಯವಾದ ${name}!\n\n🎁 *ನಿಮ್ಮ ಮೊದಲ 2 ಇರಾನಿ ಚಾಯ್ ಉಚಿತ!*\n\nನಮ್ಮ ಮೆನು ನೋಡಿ 👇`,
    ta: (name) => `நன்றி ${name}!\n\n🎁 *உங்கள் முதல் 2 இரானி சாய் இலவசம்!*\n\nஎங்கள் மெனு பாருங்கள் 👇`,
  },
  browse_menu_returning_free: {
    en: (name) => `Welcome back${name ? ' ' + name : ''}!\n\n🎁 *Your first 2 Irani Chai are FREE!*\n\nBrowse our menu, add items to cart, and send your order 👇`,
    ur: (name) => `خوش آمدید${name ? ' ' + name : ''}!\n\n🎁 *آپ کی پہلی 2 ایرانی چائے مفت!*\n\nمینو دیکھیں، آئٹمز شامل کریں، اور آرڈر بھیجیں 👇`,
    hi: (name) => `वापस स्वागत है${name ? ' ' + name : ''}!\n\n🎁 *आपकी पहली 2 ईरानी चाय मुफ़्त!*\n\nमेनू देखें, आइटम जोड़ें, और ऑर्डर भेजें 👇`,
    kn: (name) => `ಮರಳಿ ಸ್ವಾಗತ${name ? ' ' + name : ''}!\n\n🎁 *ನಿಮ್ಮ ಮೊದಲ 2 ಇರಾನಿ ಚಾಯ್ ಉಚಿತ!*\n\nಮೆನು ನೋಡಿ, ಐಟಂಗಳನ್ನು ಸೇರಿಸಿ, ಮತ್ತು ಆರ್ಡರ್ ಕಳುಹಿಸಿ 👇`,
    ta: (name) => `மீண்டும் வரவேற்கிறோம்${name ? ' ' + name : ''}!\n\n🎁 *உங்கள் முதல் 2 இரானி சாய் இலவசம்!*\n\nமெனு பாருங்கள், பொருட்களைச் சேர்க்கவும், ஆர்டர் அனுப்பவும் 👇`,
  },
  // ── Payment ──
  how_to_pay: {
    en: 'How would you like to pay?', ur: 'آپ کیسے ادائیگی کرنا چاہیں گے؟',
    hi: 'आप कैसे भुगतान करना चाहेंगे?', kn: 'ನೀವು ಹೇಗೆ ಪಾವತಿ ಮಾಡಲು ಬಯಸುತ್ತೀರಿ?',
    ta: 'எப்படி பணம் செலுத்த விரும்புகிறீர்கள்?',
  },
  your_order: {
    en: '*Your order:*', ur: '*آپ کا آرڈر:*', hi: '*आपका ऑर्डर:*',
    kn: '*ನಿಮ್ಮ ಆರ್ಡರ್:*', ta: '*உங்கள் ஆர்டர்:*',
  },
  total: {
    en: 'Total', ur: 'کل', hi: 'कुल', kn: 'ಒಟ್ಟು', ta: 'மொத்தம்',
  },
  deliver_to: {
    en: 'Deliver to', ur: 'ڈلیوری', hi: 'डिलीवरी', kn: 'ಡೆಲಿವರಿ', ta: 'டெலிவரி',
  },
  cash_on_delivery: {
    en: 'Cash on Delivery', ur: 'کیش آن ڈلیوری', hi: 'कैश ऑन डिलीवरी',
    kn: 'ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ', ta: 'கேஷ் ஆன் டெலிவரி',
  },
  // ── Button Labels ──
  btn_reorder: {
    en: (total) => `Reorder ₹${total}`, ur: (total) => `دوبارہ آرڈر ₹${total}`,
    hi: (total) => `फिर से ₹${total}`, kn: (total) => `ಮರು ₹${total}`,
    ta: (total) => `மீண்டும் ₹${total}`,
  },
  btn_new_order: {
    en: 'New Order', ur: 'نیا آرڈر', hi: 'नया ऑर्डर', kn: 'ಹೊಸ ಆರ್ಡರ್', ta: 'புதிய ஆர்டர்',
  },
  btn_change_location: {
    en: '📍 Change Location', ur: '📍 مقام تبدیل', hi: '📍 लोकेशन बदलें',
    kn: '📍 ಸ್ಥಳ ಬದಲಿಸಿ', ta: '📍 இடம் மாற்று',
  },
  btn_change_language: {
    en: '🌐 Language', ur: '🌐 زبان', hi: '🌐 भाषा', kn: '🌐 ಭಾಷೆ', ta: '🌐 மொழி',
  },
  // ── Order Confirmation ──
  order_confirmed: {
    en: (code) => `✅ *Order ${code} confirmed!*`,
    ur: (code) => `✅ *آرڈر ${code} تصدیق شدہ!*`,
    hi: (code) => `✅ *ऑर्डर ${code} कन्फर्म!*`,
    kn: (code) => `✅ *ಆರ್ಡರ್ ${code} ದೃಢೀಕರಿಸಲಾಗಿದೆ!*`,
    ta: (code) => `✅ *ஆர்டர் ${code} உறுதிப்படுத்தப்பட்டது!*`,
  },
  free_chai_applied: {
    en: (count, discount) => `🎁 ${count}x FREE Irani Chai — -₹${discount}`,
    ur: (count, discount) => `🎁 ${count}x مفت ایرانی چائے — -₹${discount}`,
    hi: (count, discount) => `🎁 ${count}x मुफ़्त ईरानी चाय — -₹${discount}`,
    kn: (count, discount) => `🎁 ${count}x ಉಚಿತ ಇರಾನಿ ಚಾಯ್ — -₹${discount}`,
    ta: (count, discount) => `🎁 ${count}x இலவச இரானி சாய் — -₹${discount}`,
  },
  runner_on_way: {
    en: (runner) => `🏃 Runner: ${runner}\n⏱️ *Arriving in ~5 minutes!*`,
    ur: (runner) => `🏃 رنر: ${runner}\n⏱️ *~5 منٹ میں پہنچ جائے گا!*`,
    hi: (runner) => `🏃 रनर: ${runner}\n⏱️ *~5 मिनट में पहुँचेगा!*`,
    kn: (runner) => `🏃 ರನ್ನರ್: ${runner}\n⏱️ *~5 ನಿಮಿಷದಲ್ಲಿ ಬರುತ್ತಾರೆ!*`,
    ta: (runner) => `🏃 ரன்னர்: ${runner}\n⏱️ *~5 நிமிடத்தில் வரும்!*`,
  },
  session_expired: {
    en: `⏰ Your previous session expired due to inactivity and your cart was cleared.\n\nNo worries — let's start fresh!`,
    ur: `⏰ آپ کا پچھلا سیشن غیر فعالیت کی وجہ سے ختم ہو گیا۔\n\nکوئی بات نہیں — نئے سرے سے شروع کرتے ہیں!`,
    hi: `⏰ आपका पिछला सेशन निष्क्रियता के कारण समाप्त हो गया।\n\nकोई बात नहीं — नए सिरे से शुरू करते हैं!`,
    kn: `⏰ ನಿಮ್ಮ ಹಿಂದಿನ ಸೆಷನ್ ನಿಷ್ಕ್ರಿಯತೆಯಿಂದ ಮುಕ್ತಾಯವಾಗಿದೆ.\n\nಚಿಂತಿಸಬೇಡಿ — ಹೊಸದಾಗಿ ಪ್ರಾರಂಭಿಸೋಣ!`,
    ta: `⏰ உங்கள் முந்தைய அமர்வு செயலற்ற நிலையால் காலாவதியானது.\n\nகவலை வேண்டாம் — புதிதாக ஆரம்பிக்கலாம்!`,
  },
  // ── Settings ──
  settings_header: {
    en: '⚙️ *Settings*', ur: '⚙️ *سیٹنگز*', hi: '⚙️ *सेटिंग्स*',
    kn: '⚙️ *ಸೆಟ್ಟಿಂಗ್ಸ್*', ta: '⚙️ *அமைப்புகள்*',
  },
};

// Helper: get translated text, fallback to English
function t(key, lang) {
  const entry = T[key];
  if (!entry) return key;
  return entry[lang] || entry['en'] || key;
}

// Helper: get user language (fallback to 'en')
function userLang(user) {
  return user?.preferred_language || 'en';
}

// Odoo POS Integration
const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
const ODOO_DB = 'main';
const ODOO_UID = 2;
const POS_CONFIG_ID = 29;
const PRICELIST_ID = 3;
const PAYMENT_METHOD_COD = 50;
const PAYMENT_METHOD_UPI = 51;

export async function onRequest(context) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(context.request.url);
  const action = url.searchParams.get('action');

  // ── Razorpay callback (GET redirect after customer pays) — MUST come before webhook verify ──
  if (context.request.method === 'GET' && action === 'razorpay-callback') {
    return handleRazorpayCallback(context, url, corsHeaders);
  }

  // ── Razorpay webhook (POST from Razorpay servers) — MUST come before WhatsApp POST handler ──
  if (context.request.method === 'POST' && action === 'razorpay-webhook') {
    return handleRazorpayWebhook(context, corsHeaders);
  }

  // ── Dashboard API (GET with action param) ──
  if (action) {
    return handleDashboardAPI(context, action, url, corsHeaders);
  }

  // ── WhatsApp webhook verification (GET) ──
  if (context.request.method === 'GET') {
    return handleWebhookVerify(context, url);
  }

  // ── WhatsApp incoming messages (POST) ──
  if (context.request.method === 'POST') {
    try {
      const body = await context.request.json();
      await processWebhook(context, body);
      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Webhook error:', error.message, error.stack);
      return new Response('OK', { status: 200 });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
}

// ─── WEBHOOK VERIFICATION ─────────────────────────────────────────
function handleWebhookVerify(context, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === context.env.WA_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ─── WEBHOOK MESSAGE PROCESSING ───────────────────────────────────
async function processWebhook(context, body) {
  const entry = body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  const phoneId = context.env.WA_PHONE_ID;
  const token = context.env.WA_ACCESS_TOKEN;
  const db = context.env.DB;

  // ── Handle payment status webhooks (from order_details native payments) ──
  // These arrive in value.statuses[] with type="payment", NOT in value.messages[]
  if (value?.statuses?.length) {
    for (const status of value.statuses) {
      if (status.type === 'payment') {
        await handlePaymentStatus(context, status, phoneId, token, db);
      }
    }
  }

  // ── Handle customer messages ──
  if (!value?.messages?.length) return;

  const message = value.messages[0];
  const waId = message.from;

  // Mark message as read
  await sendWhatsApp(phoneId, token, { messaging_product: 'whatsapp', status: 'read', message_id: message.id });

  // Load or create session
  let session = await db.prepare('SELECT * FROM wa_sessions WHERE wa_id = ?').bind(waId).first();
  if (!session) {
    const now = new Date().toISOString();
    await db.prepare('INSERT INTO wa_sessions (wa_id, state, cart, cart_total, updated_at) VALUES (?, ?, ?, ?, ?)').bind(waId, 'idle', '[]', 0, now).run();
    session = { wa_id: waId, state: 'idle', cart: '[]', cart_total: 0, updated_at: now };
  }

  // Check session expiry — notify user if they had an active cart
  const lastUpdate = new Date(session.updated_at).getTime();
  if (Date.now() - lastUpdate > SESSION_TIMEOUT_MS && session.state !== 'idle') {
    const hadCart = session.cart && session.cart !== '[]';
    const wasOrdering = ['awaiting_menu', 'awaiting_payment', 'awaiting_location', 'awaiting_location_confirm'].includes(session.state);
    session.state = 'idle';
    session.cart = '[]';
    session.cart_total = 0;
    if (hadCart && wasOrdering) {
      await sendWhatsApp(phoneId, token, buildText(waId, t('session_expired', userLang(user))));
    }
  }

  // Load or create user
  let user = await db.prepare('SELECT * FROM wa_users WHERE wa_id = ?').bind(waId).first();
  if (!user) {
    const now = new Date().toISOString();
    const name = value.contacts?.[0]?.profile?.name || '';
    const phone = waId;
    await db.prepare('INSERT INTO wa_users (wa_id, name, phone, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)').bind(waId, name, phone, now, now).run();
    user = { wa_id: waId, name, phone, first_order_redeemed: 0, total_orders: 0, last_order_id: null, location_lat: null, location_lng: null, business_type: null, preferred_language: null };
  } else {
    await db.prepare('UPDATE wa_users SET last_active_at = ? WHERE wa_id = ?').bind(new Date().toISOString(), waId).run();
  }

  const msgType = getMessageType(message);
  await routeState(context, session, user, message, msgType, waId, phoneId, token, db);
}

// ─── HANDLE WHATSAPP PAYMENT STATUS WEBHOOK ──────────────────────
// Fired when customer pays (or fails) via native order_details payment card.
// Arrives in value.statuses[] with type="payment" — NOT in value.messages[].
// status.status: "captured" (success) | "pending" (retry possible) | "failed" (terminal)
// status.payment.transaction.status: "success" | "failed" | "pending"
async function handlePaymentStatus(context, status, phoneId, token, db) {
  const paymentStatus = status.status; // "captured", "pending", "failed"
  const referenceId = status.payment?.reference_id; // Our order code (e.g. WA-0802-0001)
  const txnId = status.payment?.transaction?.id; // Razorpay order/transaction ID
  const txnStatus = status.payment?.transaction?.status; // "success", "failed", "pending"
  const customerId = status.recipient_id; // Customer's WhatsApp number
  const errorInfo = status.payment?.transaction?.error; // { code, reason } on failure

  console.log(`Payment webhook: status=${paymentStatus}, txn=${txnStatus}, ref=${referenceId}, customer=${customerId}`);

  if (!referenceId) {
    console.error('Payment status webhook missing reference_id');
    return;
  }

  // Find the order by order_code (= reference_id)
  const order = await db.prepare('SELECT * FROM wa_orders WHERE order_code = ?').bind(referenceId).first();
  if (!order) {
    console.error('Payment webhook: order not found for reference_id:', referenceId);
    return;
  }

  // ── PAYMENT CAPTURED (Success) ──
  if (paymentStatus === 'captured' && txnStatus === 'success') {
    // Idempotency: skip if already paid
    if (order.payment_status === 'paid') {
      console.log('Order already paid:', referenceId);
      return;
    }

    const now = new Date().toISOString();
    await db.prepare('UPDATE wa_orders SET payment_status = ?, razorpay_payment_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind('paid', txnId || null, 'confirmed', now, order.id).run();

    // Update user stats (deferred from order creation)
    await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?')
      .bind(order.discount, order.id, order.total, order.wa_id).run();

    // Load user for Odoo order creation
    const user = await db.prepare('SELECT * FROM wa_users WHERE wa_id = ?').bind(order.wa_id).first();
    const cart = JSON.parse(order.items);

    // Create Odoo POS order
    const odooResult = await createOdooOrder(
      context, order.order_code, cart, order.total, order.discount, 'upi',
      order.wa_id, user?.name, user?.phone, order.delivery_address,
      order.delivery_lat, order.delivery_lng, order.delivery_distance_m,
      order.runner_name, user?.business_type
    );

    // Send confirmation to customer
    const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
    let confirmMsg = `✅ *Payment received! Order ${order.order_code} confirmed!*\n\n${itemLines}`;
    if (order.discount > 0) {
      const freeCount = Math.round(order.discount / 15);
      confirmMsg += `\n🎁 ${freeCount}x FREE Irani Chai — -₹${order.discount}`;
    }
    confirmMsg += `\n\n💰 *Total: ₹${order.total}* (UPI ✓ Paid)`;
    confirmMsg += `\n📍 ${order.delivery_address || 'Location saved'}`;
    confirmMsg += `\n🏃 Runner: ${order.runner_name}`;
    confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
    if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

    await sendWhatsApp(phoneId, token, buildText(order.wa_id, confirmMsg));
    await updateSession(db, order.wa_id, 'order_placed', '[]', 0);

    console.log(`Payment confirmed for ${order.order_code}: ₹${order.total}`);
    return;
  }

  // ── PAYMENT FAILED (transaction failed, but customer can retry) ──
  if ((paymentStatus === 'pending' && txnStatus === 'failed') || paymentStatus === 'failed') {
    const reason = errorInfo?.reason || 'unknown';
    const friendlyReason = getPaymentErrorMessage(reason);

    console.log(`Payment failed for ${referenceId}: ${reason}`);

    // Don't spam — only send failure message if order is still payment_pending
    if (order.payment_status !== 'pending') return;

    let failMsg = `❌ *Payment failed* for order ${order.order_code}\n\n`;
    failMsg += `Reason: ${friendlyReason}\n\n`;

    if (paymentStatus === 'pending') {
      // Customer can retry — the order_details card is still active in WhatsApp
      failMsg += `You can tap *"Review and Pay"* again to retry.\n\n`;
    }
    failMsg += `_Or reply *"cod"* to switch to Cash on Delivery_\n_Reply *"cancel"* to cancel the order_`;

    await sendWhatsApp(phoneId, token, buildText(order.wa_id, failMsg));
    return;
  }

  // ── PAYMENT PENDING (in-progress, waiting for confirmation) ──
  if (paymentStatus === 'pending' && txnStatus === 'pending') {
    console.log(`Payment pending for ${referenceId} — waiting for final status`);
    // No action needed — wait for captured or failed webhook
    return;
  }
}

// Map Razorpay error codes to customer-friendly messages
function getPaymentErrorMessage(reason) {
  const messages = {
    'incorrect_pin': 'Incorrect UPI PIN entered',
    'insufficient_balance': 'Insufficient balance in your account',
    'transaction_timeout': 'Transaction timed out — please try again',
    'upi_invalid_beneficiary': 'Payment could not be processed',
    'bank_decline': 'Your bank declined the transaction',
    'server_error': 'Payment server issue — please try again',
    'user_cancelled': 'Payment was cancelled',
    'expired': 'Payment session expired — please try again',
  };
  return messages[reason] || 'Transaction could not be completed';
}

function getMessageType(message) {
  if (message.type === 'interactive') {
    const interactive = message.interactive;
    if (interactive.type === 'list_reply') return { type: 'list_reply', id: interactive.list_reply.id, title: interactive.list_reply.title };
    if (interactive.type === 'button_reply') return { type: 'button_reply', id: interactive.button_reply.id, title: interactive.button_reply.title };
  }
  if (message.type === 'location') {
    return { type: 'location', lat: message.location.latitude, lng: message.location.longitude, name: message.location.name || '', address: message.location.address || '' };
  }
  if (message.type === 'order') {
    // Native cart submission from MPM
    const order = message.order;
    const items = (order.product_items || []).map(item => ({
      retailer_id: item.product_retailer_id,
      qty: parseInt(item.quantity) || 1,
      price: parseFloat(item.item_price) || 0,
      currency: item.currency || 'INR',
    }));
    return { type: 'order', catalog_id: order.catalog_id, items, text: order.text || '' };
  }
  if (message.type === 'text') {
    return { type: 'text', body: message.text.body.trim(), bodyLower: message.text.body.trim().toLowerCase() };
  }
  return { type: message.type };
}

// ─── STATE MACHINE ROUTER ─────────────────────────────────────────
// States: idle → awaiting_language → awaiting_biz_type → awaiting_name → awaiting_location → awaiting_location_confirm → awaiting_menu → awaiting_payment → awaiting_upi_payment → order_placed
async function routeState(context, session, user, message, msg, waId, phoneId, token, db) {
  const state = session.state;

  // Order message can come at any time from the MPM cart — handle it directly
  if (msg.type === 'order') {
    return handleOrderMessage(context, session, user, msg, waId, phoneId, token, db);
  }

  if (state === 'order_placed' || state === 'idle') {
    return handleIdle(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_language') {
    return handleLanguageSelect(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_biz_type') {
    return handleBizType(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_name') {
    return handleName(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_location') {
    return handleLocation(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_location_confirm') {
    return handleLocationConfirm(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_menu') {
    return handleMenuState(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_payment') {
    return handlePayment(context, session, user, msg, waId, phoneId, token, db);
  }
  if (state === 'awaiting_upi_payment') {
    return handleAwaitingUpiPayment(context, session, user, msg, waId, phoneId, token, db);
  }

  return handleIdle(context, session, user, msg, waId, phoneId, token, db);
}

// ─── STATE: IDLE → Greeting / Reorder / Biz Verification ─────────
async function handleIdle(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);

  // ── RETURNING USER: show reorder prompt ──
  if (user.total_orders > 0 && user.last_order_id) {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      const itemSummary = items.map(i => `${i.qty}x ${i.name}`).join(', ');
      const firstName = user.name ? user.name.split(' ')[0] : '';
      const welcomeText = t('welcome_back', lang);
      const welcomeMsg = typeof welcomeText === 'function' ? welcomeText(firstName) : welcomeText;
      const locationNote = user.location_address ? `\n${t('delivering_to', lang)} ${user.location_address}` : '';
      const body = `${welcomeMsg}\n\n${t('your_last_order', lang)}\n${itemSummary} — *₹${lastOrder.total}*${locationNote}`;

      // Use List Message to show all options including settings
      const reorderTitle = t('btn_reorder', lang);
      const listMsg = buildListMessage(waId,
        `☕ ${welcomeMsg.replace(/\*/g, '')}`,
        body,
        t('btn_new_order', lang),
        [
          {
            title: lang === 'en' ? 'Quick Actions' : '⚡',
            rows: [
              { id: 'reorder', title: (typeof reorderTitle === 'function' ? reorderTitle(lastOrder.total) : `Reorder ₹${lastOrder.total}`).slice(0, 24), description: itemSummary.slice(0, 72) },
              { id: 'new_order', title: t('btn_new_order', lang).slice(0, 24), description: t('browse_menu', lang).slice(0, 72) },
            ]
          },
          {
            title: lang === 'en' ? 'Settings' : '⚙️',
            rows: [
              { id: 'change_location', title: t('btn_change_location', lang).slice(0, 24), description: (user.location_address || 'Update delivery location').slice(0, 72) },
              { id: 'change_language', title: t('btn_change_language', lang).slice(0, 24), description: SUPPORTED_LANGUAGES.find(l => l.code === lang)?.native || 'English' },
            ]
          }
        ]
      );
      await sendWhatsApp(phoneId, token, listMsg);
      await updateSession(db, waId, 'awaiting_menu', session.cart, session.cart_total);
      return;
    }
  }

  // ── PREVIOUSLY VERIFIED USER (no orders yet): show MPM catalog ──
  if (user.business_type && user.name && user.location_lat) {
    const firstName = user.name ? user.name.split(' ')[0] : '';
    const greeting = t('browse_menu_returning_free', lang);
    const greetingText = typeof greeting === 'function' ? greeting(firstName) : greeting;
    const locationNote = `\n\n📍 ${t('deliver_to', lang)}: ${user.location_address || 'Saved pin'}\n_Type "change location" or "change language" anytime_`;
    await sendWhatsApp(phoneId, token, buildMPM(waId, greetingText + locationNote));
    await updateSession(db, waId, 'awaiting_menu', '[]', 0);
    return;
  }

  // ── KNOWN USER but no saved location (was out of range before, or location cleared) ──
  if (user.business_type && user.name && !user.location_lat) {
    const firstName = user.name.split(' ')[0];
    const shareLocText = t('share_location', lang);
    const body = typeof shareLocText === 'function' ? shareLocText(firstName) : shareLocText;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, body));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  // ── BRAND NEW USER: ask language FIRST, then business verification ──
  // Show language selection as the very first interaction
  await sendLanguageSelection(waId, phoneId, token);
  await updateSession(db, waId, 'awaiting_language', '[]', 0);
}

// ─── SEND LANGUAGE SELECTION ─────────────────────────────────────
async function sendLanguageSelection(waId, phoneId, token) {
  // Multi-lingual greeting so everyone can read it
  const body = `🌐 *Choose your language / اپنی زبان منتخب کریں / अपनी भाषा चुनें*\n\nSelect your preferred language for ordering:`;
  const buttons = [
    { type: 'reply', reply: { id: 'lang_en', title: 'English' } },
    { type: 'reply', reply: { id: 'lang_ur', title: 'اردو (Urdu)' } },
    { type: 'reply', reply: { id: 'lang_more', title: 'More / और' } },
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
}

// ─── STATE: AWAITING LANGUAGE ─────────────────────────────────────
async function handleLanguageSelect(context, session, user, msg, waId, phoneId, token, db) {
  // Handle direct language selection
  if (msg.type === 'button_reply' && msg.id.startsWith('lang_')) {
    if (msg.id === 'lang_more') {
      // Show remaining languages
      const buttons = [
        { type: 'reply', reply: { id: 'lang_hi', title: 'हिंदी (Hindi)' } },
        { type: 'reply', reply: { id: 'lang_kn', title: 'ಕನ್ನಡ (Kannada)' } },
        { type: 'reply', reply: { id: 'lang_ta', title: 'தமிழ் (Tamil)' } },
      ];
      await sendWhatsApp(phoneId, token, buildReplyButtons(waId, '🌐 Select your language:', buttons));
      return;
    }

    const langCode = msg.id.replace('lang_', '');
    const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === langCode);
    if (langInfo) {
      // Save language preference
      await db.prepare('UPDATE wa_users SET preferred_language = ? WHERE wa_id = ?').bind(langCode, waId).run();
      user.preferred_language = langCode;

      const savedMsg = t('language_saved', langCode);
      const savedText = typeof savedMsg === 'function' ? savedMsg(langInfo.native) : savedMsg;
      await sendWhatsApp(phoneId, token, buildText(waId, savedText));

      // Now proceed to business type selection (new user flow)
      const greeting = t('new_user_greeting', langCode);
      const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
      await sendWhatsApp(phoneId, token, buildReplyButtons(waId, greeting, buttons));
      await updateSession(db, waId, 'awaiting_biz_type', '[]', 0);
      return;
    }
  }

  // Handle list_reply for language change from settings
  if (msg.type === 'list_reply' && msg.id.startsWith('lang_')) {
    const langCode = msg.id.replace('lang_', '');
    const langInfo = SUPPORTED_LANGUAGES.find(l => l.code === langCode);
    if (langInfo) {
      await db.prepare('UPDATE wa_users SET preferred_language = ? WHERE wa_id = ?').bind(langCode, waId).run();
      user.preferred_language = langCode;

      const savedMsg = t('language_saved', langCode);
      const savedText = typeof savedMsg === 'function' ? savedMsg(langInfo.native) : savedMsg;
      await sendWhatsApp(phoneId, token, buildText(waId, savedText));

      // Return to idle to restart normal flow with new language
      await updateSession(db, waId, 'idle', '[]', 0);
      return handleIdle(context, session, user, msg, waId, phoneId, token, db);
    }
  }

  // Invalid response — resend language options
  await sendLanguageSelection(waId, phoneId, token);
}

// ─── STATE: AWAITING BIZ TYPE ─────────────────────────────────────
async function handleBizType(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);
  if (msg.type === 'button_reply' && msg.id.startsWith('biz_')) {
    const categoryTitle = BIZ_CATEGORIES.find(c => c.id === msg.id)?.title || msg.title;
    await db.prepare('UPDATE wa_users SET business_type = ? WHERE wa_id = ?').bind(categoryTitle, waId).run();
    user.business_type = categoryTitle;

    await sendWhatsApp(phoneId, token, buildText(waId, t('great_whats_your_name', lang)));
    await updateSession(db, waId, 'awaiting_name', '[]', 0);
    return;
  }

  const buttons = BIZ_CATEGORIES.map(c => ({ type: 'reply', reply: { id: c.id, title: c.title } }));
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, t('select_biz_type', lang), buttons));
}

// ─── STATE: AWAITING NAME ─────────────────────────────────────────
async function handleName(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);
  if (msg.type === 'text' && msg.body.length > 0) {
    const name = msg.body.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ').slice(0, 50);
    await db.prepare('UPDATE wa_users SET name = ? WHERE wa_id = ?').bind(name, waId).run();
    user.name = name;

    // Check if user already has saved location within range
    if (user.location_lat && user.location_lng) {
      const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
      if (dist <= MAX_DELIVERY_RADIUS_M) {
        const isNew = !user.first_order_redeemed && user.total_orders === 0;
        const firstName = name.split(' ')[0];
        let menuIntro;
        if (isNew) {
          const freeMsg = t('browse_menu_free_chai', lang);
          menuIntro = typeof freeMsg === 'function' ? freeMsg(firstName) : freeMsg;
        } else {
          menuIntro = `${firstName}! ${t('browse_menu', lang)}`;
        }
        await sendWhatsApp(phoneId, token, buildMPM(waId, menuIntro));
        await updateSession(db, waId, 'awaiting_menu', '[]', 0);
        return;
      }
    }

    const shareLocText = t('share_location', lang);
    const body = typeof shareLocText === 'function' ? shareLocText(name.split(' ')[0]) : shareLocText;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, body));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  await sendWhatsApp(phoneId, token, buildText(waId, t('type_name_to_continue', lang)));
}

// ─── STATE: AWAITING LOCATION ─────────────────────────────────────
async function handleLocation(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);
  if (msg.type !== 'location') {
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, t('share_location_generic', lang)));
    return;
  }

  const { lat, lng, name, address } = msg;
  const distance = haversineDistance(lat, lng, NCH_LAT, NCH_LNG);

  if (distance > MAX_DELIVERY_RADIUS_M) {
    const distStr = distance > 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)}m`;
    const outOfRange = t('out_of_range', lang);
    const body = typeof outOfRange === 'function' ? outOfRange(distStr) : outOfRange;
    await sendWhatsApp(phoneId, token, buildText(waId, body));
    await updateSession(db, waId, 'idle', '[]', 0);
    return;
  }

  // Save raw location temporarily (will be updated after confirmation)
  const rawLocationText = name || address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  await db.prepare('UPDATE wa_users SET location_lat = ?, location_lng = ?, location_address = ? WHERE wa_id = ?').bind(lat, lng, rawLocationText, waId).run();
  user.location_lat = lat;
  user.location_lng = lng;
  user.location_address = rawLocationText;
  user.delivery_distance_m = Math.round(distance);

  // Search for nearby businesses using Google Places API
  const placesApiKey = context.env.GOOGLE_PLACES_KEY;
  if (placesApiKey) {
    try {
      const places = await searchNearbyPlaces(lat, lng, placesApiKey);
      if (places && places.length > 0) {
        // Store places + page offset in session metadata (use cart field since it's JSON)
        const locationMeta = {
          lat, lng, distance: Math.round(distance), rawLocationText,
          allPlaces: places, // Store all results (up to 20)
          pageOffset: 0,     // Current page (0 = first 5, 1 = next 5, etc.)
          originalCart: session.cart, originalCartTotal: session.cart_total
        };
        await updateSession(db, waId, 'awaiting_location_confirm', JSON.stringify(locationMeta), session.cart_total);

        // Show first 5 places
        const firstPage = places.slice(0, 5);
        const hasMore = places.length > 5;
        const listMsg = buildLocationConfirmList(waId, firstPage, hasMore, Math.round(distance));
        await sendWhatsApp(phoneId, token, listMsg);
        return;
      }
    } catch (e) {
      console.error('Google Places search failed:', e.message, e.stack);
    }
  }

  // Fallback: no Places API key or no results — proceed directly (old behavior)
  await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, Math.round(distance));
}

// ─── STATE: AWAITING LOCATION CONFIRM (Google Places selection) ──
async function handleLocationConfirm(context, session, user, msg, waId, phoneId, token, db) {
  // Parse stored location metadata
  let locationMeta;
  try {
    locationMeta = JSON.parse(session.cart || '{}');
  } catch {
    // Corrupted state — restart location flow
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Something went wrong. Please share your location again:'));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  const { lat, lng, distance, rawLocationText, allPlaces, pageOffset, originalCart, originalCartTotal } = locationMeta;

  // ── Customer selected a place from the list ──
  if (msg.type === 'list_reply') {
    const selectedId = msg.id;

    // "Show More" option
    if (selectedId === 'loc_show_more') {
      const newOffset = (pageOffset || 0) + 5;
      const nextPage = (allPlaces || []).slice(newOffset, newOffset + 5);

      if (nextPage.length === 0) {
        // No more results — offer manual entry
        const buttons = [
          { type: 'reply', reply: { id: 'loc_manual', title: 'Type my business' } },
          { type: 'reply', reply: { id: 'loc_pin_ok', title: '📍 Pin is correct' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId,
          `We've shown all nearby listings.\n\nYou can:\n• *Type your business name* so our runner knows exactly where to come\n• *Confirm your pin* is accurate and we'll use that`,
          buttons));
        return;
      }

      // Show next page
      locationMeta.pageOffset = newOffset;
      await updateSession(db, waId, 'awaiting_location_confirm', JSON.stringify(locationMeta), originalCartTotal || 0);
      const hasMore = (allPlaces || []).length > newOffset + 5;
      const listMsg = buildLocationConfirmList(waId, nextPage, hasMore, distance);
      await sendWhatsApp(phoneId, token, listMsg);
      return;
    }

    // "Not here / Enter manually" option
    if (selectedId === 'loc_not_here') {
      const buttons = [
        { type: 'reply', reply: { id: 'loc_manual', title: 'Type my business' } },
        { type: 'reply', reply: { id: 'loc_pin_ok', title: '📍 Pin is correct' } }
      ];
      await sendWhatsApp(phoneId, token, buildReplyButtons(waId,
        `No worries! You can:\n\n• *Type your business name* so our runner finds you easily\n• *Confirm your pin location* is accurate and we'll deliver there`,
        buttons));
      return;
    }

    // Customer selected a specific place
    if (selectedId.startsWith('loc_place_')) {
      const placeIndex = parseInt(selectedId.replace('loc_place_', ''));
      const selectedPlace = (allPlaces || [])[placeIndex];
      if (selectedPlace) {
        // Update location with the confirmed business name + address
        const confirmedAddress = selectedPlace.name + (selectedPlace.address ? ` — ${selectedPlace.address}` : '');
        await db.prepare('UPDATE wa_users SET location_address = ? WHERE wa_id = ?').bind(confirmedAddress, waId).run();
        user.location_address = confirmedAddress;

        await sendWhatsApp(phoneId, token, buildText(waId, `✅ *${selectedPlace.name}* — got it! Our runner will find you there.`));

        // Restore original cart and proceed
        const restoredCart = originalCart || '[]';
        const restoredTotal = originalCartTotal || 0;
        session.cart = restoredCart;
        session.cart_total = restoredTotal;
        await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance);
        return;
      }
    }
  }

  // ── "Pin is correct" button ──
  if (msg.type === 'button_reply' && msg.id === 'loc_pin_ok') {
    await sendWhatsApp(phoneId, token, buildText(waId, `✅ Pin location confirmed! (${distance}m from NCH)`));
    session.cart = originalCart || '[]';
    session.cart_total = originalCartTotal || 0;
    await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance);
    return;
  }

  // ── "Type my business" button → ask them to type it ──
  if (msg.type === 'button_reply' && msg.id === 'loc_manual') {
    // Update session to signal we're waiting for manual business name
    locationMeta.awaitingManualName = true;
    await updateSession(db, waId, 'awaiting_location_confirm', JSON.stringify(locationMeta), originalCartTotal || 0);
    await sendWhatsApp(phoneId, token, buildText(waId, `📝 Type your business/shop name and we'll save it for delivery:`));
    return;
  }

  // ── Manual business name text input ──
  if (msg.type === 'text' && locationMeta.awaitingManualName) {
    const businessName = (msg.body || '').slice(0, 100); // Cap at 100 chars

    // Tier 2: Try Google Text Search to find the typed name near the pin
    const placesApiKey = context.env.GOOGLE_PLACES_KEY;
    if (placesApiKey && businessName.length >= 3) {
      try {
        const textResults = await searchPlacesByName(businessName, lat, lng, placesApiKey);
        if (textResults && textResults.length > 0) {
          // Found matches — show them as a list so customer can confirm
          locationMeta.awaitingManualName = false;
          locationMeta.textSearchResults = textResults;
          locationMeta.typedName = businessName;
          await updateSession(db, waId, 'awaiting_location_confirm', JSON.stringify(locationMeta), originalCartTotal || 0);

          const rows = textResults.map((p, i) => ({
            id: `loc_text_${i}`,
            title: p.name.slice(0, 24),
            description: (p.primaryType ? p.primaryType + ' — ' : '') + (p.address || '').slice(0, 72 - (p.primaryType ? p.primaryType.length + 3 : 0))
          }));
          rows.push({
            id: 'loc_use_typed',
            title: '📝 Use typed name',
            description: `Save "${businessName.slice(0, 50)}" as-is`
          });

          const listMsg = buildListMessage(waId,
            '📍',
            `We found these for "${businessName}" near your pin:\n\nSelect the correct one, or use your typed name:`,
            'Select',
            [{ title: 'Search Results', rows }]
          );
          await sendWhatsApp(phoneId, token, listMsg);
          return;
        }
      } catch (e) {
        console.error('Text search failed, using typed name:', e.message);
      }
    }

    // No Text Search results or API unavailable — save typed name directly
    const confirmedAddress = businessName;
    await db.prepare('UPDATE wa_users SET location_address = ? WHERE wa_id = ?').bind(confirmedAddress, waId).run();
    user.location_address = confirmedAddress;

    await sendWhatsApp(phoneId, token, buildText(waId, `✅ *${businessName}* — saved! Our runner will deliver to you there.`));

    session.cart = originalCart || '[]';
    session.cart_total = originalCartTotal || 0;
    await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance);
    return;
  }

  // ── Text Search result selection ──
  if (msg.type === 'list_reply' && msg.id.startsWith('loc_text_')) {
    const idx = parseInt(msg.id.replace('loc_text_', ''));
    const results = locationMeta.textSearchResults || [];
    const selected = results[idx];
    if (selected) {
      const confirmedAddress = selected.name + (selected.address ? ` — ${selected.address}` : '');
      await db.prepare('UPDATE wa_users SET location_address = ? WHERE wa_id = ?').bind(confirmedAddress, waId).run();
      user.location_address = confirmedAddress;

      await sendWhatsApp(phoneId, token, buildText(waId, `✅ *${selected.name}* — got it! Our runner will find you there.`));

      session.cart = originalCart || '[]';
      session.cart_total = originalCartTotal || 0;
      await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance);
      return;
    }
  }

  // ── "Use typed name" from text search results ──
  if (msg.type === 'list_reply' && msg.id === 'loc_use_typed') {
    const typedName = locationMeta.typedName || 'My Business';
    await db.prepare('UPDATE wa_users SET location_address = ? WHERE wa_id = ?').bind(typedName, waId).run();
    user.location_address = typedName;

    await sendWhatsApp(phoneId, token, buildText(waId, `✅ *${typedName}* — saved! Our runner will deliver to you there.`));

    session.cart = originalCart || '[]';
    session.cart_total = originalCartTotal || 0;
    await proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance);
    return;
  }

  // ── Any other message → resend the list ──
  if (allPlaces && allPlaces.length > 0) {
    const currentPage = (allPlaces || []).slice(pageOffset || 0, (pageOffset || 0) + 5);
    const hasMore = (allPlaces || []).length > (pageOffset || 0) + 5;
    const listMsg = buildLocationConfirmList(waId, currentPage, hasMore, distance);
    await sendWhatsApp(phoneId, token, listMsg);
  } else {
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Please share your delivery location:'));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
  }
}

// ─── PROCEED AFTER LOCATION IS CONFIRMED ─────────────────────────
// Common logic used after location is verified (by place selection, pin confirmation, or manual entry)
async function proceedAfterLocationConfirm(context, session, user, waId, phoneId, token, db, distance) {
  // Check if cart already has items (reorder flow needing location)
  const cart = JSON.parse(session.cart || '[]');
  if (cart.length > 0) {
    const locationLabel = user.location_address || 'Saved pin';
    const body = `📍 Location saved! (${distance}m from NCH)\n📍 *Deliver to:* ${locationLabel}\n\nHow would you like to pay?`;
    const buttons = [
      { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } },
      { type: 'reply', reply: { id: 'pay_change_loc', title: '📍 Change Location' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
    await updateSession(db, waId, 'awaiting_payment', session.cart, session.cart_total);
    return;
  }

  // Show MPM catalog
  const isNew = !user.first_order_redeemed && user.total_orders === 0;
  const firstName = user.name ? user.name.split(' ')[0] : '';
  let menuIntro = `📍 You're ${distance}m from NCH — we'll be there in minutes!\n\nBrowse our menu 👇`;
  if (isNew) {
    menuIntro = `📍 You're ${distance}m from NCH.\n\n🎁 *${firstName ? firstName + ', your' : 'Your'} first 2 Irani Chai are FREE!*\n\nBrowse our menu 👇`;
  }
  await sendWhatsApp(phoneId, token, buildMPM(waId, menuIntro));
  await updateSession(db, waId, 'awaiting_menu', '[]', 0);
}

// ─── STATE: AWAITING MENU → Waiting for cart or reorder ───────────
async function handleMenuState(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);

  // ── Change Language button/list_reply ──
  if ((msg.type === 'button_reply' || msg.type === 'list_reply') && msg.id === 'change_language') {
    // Show full language selection list
    const langRows = SUPPORTED_LANGUAGES.map(l => ({
      id: `lang_${l.code}`,
      title: l.code === 'en' ? l.native : `${l.native} (${l.name})`,
      description: l.name
    }));
    const langList = buildListMessage(waId,
      '🌐',
      t('choose_language', lang),
      lang === 'en' ? 'Select language' : '🌐',
      [{ title: 'Languages', rows: langRows }]
    );
    await sendWhatsApp(phoneId, token, langList);
    await updateSession(db, waId, 'awaiting_language', session.cart, session.cart_total);
    return;
  }

  // ── Reorder button ──
  if ((msg.type === 'button_reply' || msg.type === 'list_reply') && msg.id === 'reorder') {
    const lastOrder = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(user.last_order_id).first();
    if (lastOrder) {
      const items = JSON.parse(lastOrder.items);
      // Recalculate prices from current PRODUCTS
      const updatedItems = items.map(item => {
        const prod = Object.values(PRODUCTS).find(p => p.odooId === item.odooId);
        return prod ? { ...item, price: prod.price } : item;
      });
      const cartTotal = updatedItems.reduce((sum, i) => sum + (i.price * i.qty), 0);

      if (user.location_lat && user.location_lng) {
        // Re-verify distance (location may be stale)
        const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
        if (dist > MAX_DELIVERY_RADIUS_M) {
          // Location is now out of range — clear it and ask again
          await db.prepare('UPDATE wa_users SET location_lat = NULL, location_lng = NULL, location_address = NULL WHERE wa_id = ?').bind(waId).run();
          user.location_lat = null;
          const distStr = dist > 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)}m`;
          await sendWhatsApp(phoneId, token, buildText(waId, `📍 Your saved location is *${distStr}* away — outside our delivery area.\n\nPlease share your current location so we can check again.`));
          await updateSession(db, waId, 'awaiting_location', JSON.stringify(updatedItems), cartTotal);
          await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location:'));
          return;
        }
        await updateSession(db, waId, 'awaiting_payment', JSON.stringify(updatedItems), cartTotal);
        const body = `📍 *Deliver to:* ${user.location_address || 'your saved location'}\n\nHow would you like to pay?`;
        const buttons = [
          { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
          { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } },
          { type: 'reply', reply: { id: 'pay_change_loc', title: '📍 Change Location' } }
        ];
        await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
        return;
      }

      await updateSession(db, waId, 'awaiting_location', JSON.stringify(updatedItems), cartTotal);
      await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location so we can get your order to you!'));
      return;
    }
  }

  // ── New Order button ──
  if ((msg.type === 'button_reply' || msg.type === 'list_reply') && msg.id === 'new_order') {
    await sendWhatsApp(phoneId, token, buildMPM(waId, t('browse_menu', lang)));
    await updateSession(db, waId, 'awaiting_menu', '[]', 0);
    return;
  }

  // ── Change Location button ──
  if ((msg.type === 'button_reply' || msg.type === 'list_reply') && msg.id === 'change_location') {
    // Clear saved location so it gets re-verified
    await db.prepare('UPDATE wa_users SET location_lat = NULL, location_lng = NULL, location_address = NULL WHERE wa_id = ?').bind(waId).run();
    user.location_lat = null;
    user.location_lng = null;
    user.location_address = null;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, t('share_new_location', lang)));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  // ── "Location is correct" button — just acknowledge and stay in menu ──
  if (msg.type === 'button_reply' && msg.id === 'continue_ordering') {
    await sendWhatsApp(phoneId, token, buildText(waId, `👍 Great! Browse the menu above and send your order when ready.`));
    return;
  }

  // ── Text command: "change location" / "location" — same as button ──
  if (msg.type === 'text' && /^(change\s*location|location|change\s*loc)$/i.test(msg.body || msg.bodyLower)) {
    await db.prepare('UPDATE wa_users SET location_lat = NULL, location_lng = NULL, location_address = NULL WHERE wa_id = ?').bind(waId).run();
    user.location_lat = null;
    user.location_lng = null;
    user.location_address = null;
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, t('share_new_location', lang)));
    await updateSession(db, waId, 'awaiting_location', '[]', 0);
    return;
  }

  // ── Text command: "change language" / "language" / "lang" ──
  if (msg.type === 'text' && /^(change\s*lang(uage)?|lang(uage)?|bhasha|زبان|भाषा|ಭಾಷೆ|மொழி)$/i.test(msg.body || msg.bodyLower)) {
    const langRows = SUPPORTED_LANGUAGES.map(l => ({
      id: `lang_${l.code}`,
      title: l.code === 'en' ? l.native : `${l.native} (${l.name})`,
      description: l.name
    }));
    const langList = buildListMessage(waId, '🌐', t('choose_language', lang), lang === 'en' ? 'Select language' : '🌐', [{ title: 'Languages', rows: langRows }]);
    await sendWhatsApp(phoneId, token, langList);
    await updateSession(db, waId, 'awaiting_language', session.cart, session.cart_total);
    return;
  }

  // ── Any text → resend catalog ──
  await sendWhatsApp(phoneId, token, buildMPM(waId, t('browse_menu', lang)));
}

// ─── HANDLE ORDER MESSAGE (from MPM native cart) ──────────────────
async function handleOrderMessage(context, session, user, msg, waId, phoneId, token, db) {
  const orderItems = msg.items;
  if (!orderItems || orderItems.length === 0) {
    await sendWhatsApp(phoneId, token, buildText(waId, "We couldn't read your order. Please try again from the menu."));
    await sendWhatsApp(phoneId, token, buildMPM(waId, 'Browse our menu 👇'));
    return;
  }

  // Build cart from catalog order
  const cart = [];
  let cartTotal = 0;
  for (const item of orderItems) {
    const product = PRODUCTS[item.retailer_id];
    if (!product) continue;
    const qty = item.qty;
    const price = product.price; // Use our price, not the catalog price (in case of sync issues)
    cart.push({
      code: item.retailer_id,
      name: product.name,
      price,
      qty,
      odooId: product.odooId,
    });
    cartTotal += price * qty;
  }

  if (cart.length === 0) {
    await sendWhatsApp(phoneId, token, buildText(waId, "Sorry, we couldn't process those items. Please try again."));
    return;
  }

  // Save cart to session
  await updateSession(db, waId, 'awaiting_payment', JSON.stringify(cart), cartTotal);

  // Check if user has location
  if (!user.location_lat || !user.location_lng) {
    // Need location first
    await updateSession(db, waId, 'awaiting_location', JSON.stringify(cart), cartTotal);
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Great choices! Share your delivery location so we can get your order to you.'));
    return;
  }

  // Re-verify distance (saved location may be stale)
  const dist = haversineDistance(user.location_lat, user.location_lng, NCH_LAT, NCH_LNG);
  if (dist > MAX_DELIVERY_RADIUS_M) {
    await db.prepare('UPDATE wa_users SET location_lat = NULL, location_lng = NULL, location_address = NULL WHERE wa_id = ?').bind(waId).run();
    user.location_lat = null;
    const distStr = dist > 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)}m`;
    await sendWhatsApp(phoneId, token, buildText(waId, `📍 Your saved location is *${distStr}* away — outside our delivery area.\n\nPlease share your current location so we can check again.`));
    await updateSession(db, waId, 'awaiting_location', JSON.stringify(cart), cartTotal);
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, '📍 Share your delivery location:'));
    return;
  }

  // Show order summary + payment buttons
  const cartSummary = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');

  // Preview discount for first-time users
  let discountPreview = '';
  if (!user.first_order_redeemed) {
    const chaiInCart = cart.filter(c => c.odooId === 1028).reduce((sum, c) => sum + c.qty, 0);
    if (chaiInCart > 0) {
      const freeCount = Math.min(chaiInCart, 2);
      const discountAmt = freeCount * 15;
      discountPreview = `\n🎁 ${freeCount}x FREE Irani Chai — -₹${discountAmt}`;
      cartTotal = Math.max(0, cartTotal - discountAmt);
    }
  }

  const locationLabel = user.location_address || 'Saved pin';
  const body = `*Your order:*\n${cartSummary}${discountPreview}\n\n💰 *Total: ₹${cartTotal}*\n📍 *Deliver to:* ${locationLabel}\n\nHow would you like to pay?`;
  const buttons = [
    { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
    { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } },
    { type: 'reply', reply: { id: 'pay_change_loc', title: '📍 Change Location' } }
  ];
  await sendWhatsApp(phoneId, token, buildReplyButtons(waId, body, buttons));
}

// ─── STATE: AWAITING PAYMENT → COD or UPI ─────────────────────────
async function handlePayment(context, session, user, msg, waId, phoneId, token, db) {
  const lang = userLang(user);
  // ── Change Location from payment screen ──
  if (msg.type === 'button_reply' && msg.id === 'pay_change_loc') {
    await db.prepare('UPDATE wa_users SET location_lat = NULL, location_lng = NULL, location_address = NULL WHERE wa_id = ?').bind(waId).run();
    user.location_lat = null;
    user.location_lng = null;
    user.location_address = null;
    // Keep cart intact — move to awaiting_location so after new location, goes back to payment
    await sendWhatsApp(phoneId, token, buildLocationRequest(waId, t('share_new_location', lang)));
    await updateSession(db, waId, 'awaiting_location', session.cart, session.cart_total);
    return;
  }

  if (msg.type !== 'button_reply' || !msg.id.startsWith('pay_')) {
    const locationLabel = user.location_address || 'Saved pin';
    const buttons = [
      { type: 'reply', reply: { id: 'pay_cod', title: 'Cash on Delivery' } },
      { type: 'reply', reply: { id: 'pay_upi', title: 'UPI' } },
      { type: 'reply', reply: { id: 'pay_change_loc', title: '📍 Change Location' } }
    ];
    await sendWhatsApp(phoneId, token, buildReplyButtons(waId, `📍 Deliver to: ${locationLabel}\n\nPlease select a payment method:`, buttons));
    return;
  }

  const paymentMethod = msg.id === 'pay_cod' ? 'cod' : 'upi';
  const cart = JSON.parse(session.cart || '[]');
  const subtotal = cart.reduce((sum, c) => sum + (c.price * c.qty), 0);

  // Free first chai logic — 2 free Irani Chai at ₹15 each
  let discount = 0;
  let discountReason = null;
  if (!user.first_order_redeemed) {
    const chaiInCart = cart.filter(c => c.odooId === 1028).reduce((sum, c) => sum + c.qty, 0);
    if (chaiInCart > 0) {
      const freeChaiCount = Math.min(chaiInCart, 2);
      discount = freeChaiCount * 15;
      discountReason = 'first_order_2_free_chai';
    }
  }

  const total = Math.max(0, subtotal - discount);
  const now = new Date().toISOString();

  // IST date for order code (India timezone)
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const istDateStr = istNow.toISOString().slice(0, 10); // YYYY-MM-DD
  const dd = istDateStr.slice(8, 10);
  const mm = istDateStr.slice(5, 7);
  const datePrefix = `${dd}${mm}`; // e.g. "0802" for Feb 8
  const countResult = await db.prepare("SELECT COUNT(*) as cnt FROM wa_orders WHERE order_code LIKE ?").bind(`WA-${datePrefix}-%`).first();
  const todayCount = (countResult?.cnt || 0) + 1;
  const orderCode = `WA-${datePrefix}-${String(todayCount).padStart(4, '0')}`;

  // Assign runner (round-robin)
  const runnerCounts = await db.prepare("SELECT runner_name, COUNT(*) as cnt FROM wa_orders WHERE created_at >= date('now', 'start of day') AND runner_name IS NOT NULL GROUP BY runner_name").all();
  const countMap = {};
  (runnerCounts.results || []).forEach(r => { countMap[r.runner_name] = r.cnt; });
  let assignedRunner = RUNNERS[0];
  let minOrders = Infinity;
  RUNNERS.forEach(name => {
    const cnt = countMap[name] || 0;
    if (cnt < minOrders) { minOrders = cnt; assignedRunner = name; }
  });

  const deliveryLat = user.location_lat;
  const deliveryLng = user.location_lng;
  const deliveryAddress = user.location_address || '';
  const deliveryDistance = user.delivery_distance_m || (deliveryLat ? Math.round(haversineDistance(deliveryLat, deliveryLng, NCH_LAT, NCH_LNG)) : null);

  // ── UPI FLOW: Native WhatsApp Payment via Razorpay Gateway ──
  if (paymentMethod === 'upi') {
    // Create order in DB with payment_pending status
    const orderStatus = total === 0 ? 'confirmed' : 'payment_pending';
    const result = await db.prepare(
      `INSERT INTO wa_orders (order_code, wa_id, items, subtotal, discount, discount_reason, total, payment_method, payment_status, delivery_lat, delivery_lng, delivery_address, delivery_distance_m, runner_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(orderCode, waId, JSON.stringify(cart), subtotal, discount, discountReason, total, 'upi', total === 0 ? 'paid' : 'pending', deliveryLat, deliveryLng, deliveryAddress, deliveryDistance, assignedRunner, orderStatus, now, now).run();
    const orderId = result.meta?.last_row_id;

    // If total is ₹0 (free chai only), skip payment — confirm immediately
    if (total === 0) {
      await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?').bind(discount, orderId, total, waId).run();
      const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, 'upi', waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner, user.business_type);
      const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
      let confirmMsg = `✅ *Order ${orderCode} confirmed!*\n\n${itemLines}`;
      if (discount > 0) confirmMsg += `\n🎁 ${Math.round(discount / 15)}x FREE Irani Chai — -₹${discount}`;
      confirmMsg += `\n\n💰 *Total: ₹0* (Free!)`;
      confirmMsg += `\n📍 ${deliveryAddress}\n🏃 Runner: ${assignedRunner}\n⏱️ *Arriving in ~5 minutes!*`;
      if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;
      await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
      await updateSession(db, waId, 'order_placed', '[]', 0);
      return;
    }

    // NOTE: User stats (total_orders, first_order_redeemed) are NOT updated here.
    // They are deferred to payment confirmation (Razorpay webhook/callback or COD switch)
    // to prevent inflated stats and lost free-chai promo on abandoned UPI orders.

    // Send native order_details payment card — Razorpay handles payment inside WhatsApp
    const orderDetailsMsg = buildOrderDetailsPayment(waId, orderCode, cart, total, discount);
    const payResponse = await sendWhatsApp(phoneId, token, orderDetailsMsg);

    if (!payResponse || !payResponse.ok) {
      // Fallback: create Razorpay Payment Link and send as text (covers API error + sendWhatsApp crash)
      console.error('order_details failed, falling back to payment link');
      const paymentLink = await createRazorpayPaymentLink(context, {
        amount: total, orderCode, orderId,
        customerName: user.name || 'Customer',
        customerPhone: waId.startsWith('91') ? '+' + waId : waId,
        cart, discount,
      });
      if (paymentLink) {
        await db.prepare('UPDATE wa_orders SET razorpay_link_id = ?, razorpay_link_url = ? WHERE id = ?')
          .bind(paymentLink.id, paymentLink.short_url, orderId).run();
        const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
        let payMsg = `*Order ${orderCode}*\n\n${itemLines}`;
        if (discount > 0) payMsg += `\n🎁 ${Math.round(discount / 15)}x FREE Irani Chai — -₹${discount}`;
        payMsg += `\n\n💰 *Pay ₹${total} via UPI*\n\n👇 Tap to pay\n${paymentLink.short_url}`;
        payMsg += `\n\n_Link expires in 20 minutes_\n_Reply *"cod"* to switch to Cash on Delivery_`;
        await sendWhatsApp(phoneId, token, buildText(waId, payMsg));
      } else {
        // Both failed — fall back to COD
        await db.prepare('UPDATE wa_orders SET payment_method = ?, payment_status = ?, status = ? WHERE id = ?').bind('cod', 'pending', 'confirmed', orderId).run();
        // Update user stats NOW (COD fallback = order is confirmed)
        await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?').bind(discount, orderId, total, waId).run();
        const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, 'cod', waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner, user.business_type);
        const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
        let confirmMsg = `✅ *Order ${orderCode} confirmed!*\n\n${itemLines}`;
        if (discount > 0) confirmMsg += `\n🎁 ${Math.round(discount / 15)}x FREE Irani Chai — -₹${discount}`;
        confirmMsg += `\n\n⚠️ Payment couldn't be set up. Switched to *Cash on Delivery*.\n💰 *Total: ₹${total}*`;
        confirmMsg += `\n📍 ${deliveryAddress}\n🏃 Runner: ${assignedRunner}\n⏱️ *Arriving in ~5 minutes!*`;
        if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;
        await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
        await updateSession(db, waId, 'order_placed', '[]', 0);
        return;
      }
    }

    await updateSession(db, waId, 'awaiting_upi_payment', '[]', 0);
    return;
  }

  // ── COD FLOW: Instant confirmation (unchanged) ──
  const result = await db.prepare(
    `INSERT INTO wa_orders (order_code, wa_id, items, subtotal, discount, discount_reason, total, payment_method, payment_status, delivery_lat, delivery_lng, delivery_address, delivery_distance_m, runner_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(orderCode, waId, JSON.stringify(cart), subtotal, discount, discountReason, total, 'cod', 'pending', deliveryLat, deliveryLng, deliveryAddress, deliveryDistance, assignedRunner, now, now).run();

  const orderId = result.meta?.last_row_id;

  await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?').bind(discount, orderId, total, waId).run();

  // Create order in Odoo POS
  const odooResult = await createOdooOrder(context, orderCode, cart, total, discount, 'cod', waId, user.name, user.phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, assignedRunner, user.business_type);

  const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
  let confirmMsg = `✅ *Order ${orderCode} confirmed!*\n\n${itemLines}`;
  if (discount > 0) {
    const freeCount = Math.round(discount / 15);
    confirmMsg += `\n🎁 ${freeCount}x FREE Irani Chai — -₹${discount}`;
  }
  confirmMsg += `\n\n💰 *Total: ₹${total}* (Cash on Delivery)`;
  confirmMsg += `\n📍 ${deliveryAddress}`;
  confirmMsg += `\n🏃 Runner: ${assignedRunner}`;
  confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
  if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

  await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
  await updateSession(db, waId, 'order_placed', '[]', 0);
}

// ─── STATE: AWAITING UPI PAYMENT → Customer has payment link ────
async function handleAwaitingUpiPayment(context, session, user, msg, waId, phoneId, token, db) {
  // Check if their last order's payment came through
  const pendingOrder = await db.prepare("SELECT * FROM wa_orders WHERE wa_id = ? AND status = 'payment_pending' ORDER BY created_at DESC LIMIT 1").bind(waId).first();

  if (pendingOrder) {
    // Check if payment link has expired (20 min link + 1 min buffer)
    const orderTime = new Date(pendingOrder.created_at).getTime();
    const isExpired = (Date.now() - orderTime) > (21 * 60 * 1000); // 21 min buffer

    // Allow cancel
    if (msg.type === 'text' && msg.bodyLower === 'cancel') {
      await db.prepare("UPDATE wa_orders SET status = 'cancelled', payment_status = 'cancelled', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), pendingOrder.id).run();
      await sendWhatsApp(phoneId, token, buildText(waId, `❌ Order *${pendingOrder.order_code}* cancelled.\n\nSend "hi" to start a new order!`));
      await updateSession(db, waId, 'idle', '[]', 0);
      return;
    }

    // Allow switching to COD
    if (msg.type === 'text' && msg.bodyLower === 'cod') {
      const now = new Date().toISOString();
      await db.prepare("UPDATE wa_orders SET payment_method = 'cod', payment_status = 'pending', status = 'confirmed', updated_at = ? WHERE id = ?").bind(now, pendingOrder.id).run();

      // Update user stats NOW (deferred from UPI order creation)
      await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?')
        .bind(pendingOrder.discount, pendingOrder.id, pendingOrder.total, waId).run();

      const cart = JSON.parse(pendingOrder.items);
      const odooResult = await createOdooOrder(
        context, pendingOrder.order_code, cart, pendingOrder.total, pendingOrder.discount, 'cod',
        pendingOrder.wa_id, user?.name, user?.phone, pendingOrder.delivery_address,
        pendingOrder.delivery_lat, pendingOrder.delivery_lng, pendingOrder.delivery_distance_m,
        pendingOrder.runner_name, user?.business_type
      );

      const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
      let confirmMsg = `✅ *Order ${pendingOrder.order_code} confirmed!*\n\n${itemLines}`;
      if (pendingOrder.discount > 0) confirmMsg += `\n🎁 ${Math.round(pendingOrder.discount / 15)}x FREE Irani Chai — -₹${pendingOrder.discount}`;
      confirmMsg += `\n\n💰 *Total: ₹${pendingOrder.total}* (Cash on Delivery)`;
      confirmMsg += `\n📍 ${pendingOrder.delivery_address || 'Location saved'}\n🏃 Runner: ${pendingOrder.runner_name}\n⏱️ *Arriving in ~5 minutes!*`;
      if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;
      await sendWhatsApp(phoneId, token, buildText(waId, confirmMsg));
      await updateSession(db, waId, 'order_placed', '[]', 0);
      return;
    }

    if (isExpired) {
      // Auto-expire the order
      await db.prepare("UPDATE wa_orders SET status = 'cancelled', payment_status = 'expired', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), pendingOrder.id).run();
      await sendWhatsApp(phoneId, token, buildText(waId, `⏰ Your payment for *${pendingOrder.order_code}* has expired.\n\nNo worries — send "hi" to start a new order!`));
      await updateSession(db, waId, 'idle', '[]', 0);
      return;
    }

    // Still waiting — nudge with appropriate message
    const linkUrl = pendingOrder.razorpay_link_url;
    let nudgeMsg = `⏳ Your payment for *${pendingOrder.order_code}* (₹${pendingOrder.total}) is pending.`;
    if (linkUrl) {
      nudgeMsg += `\n\n👇 Tap to pay via UPI:\n${linkUrl}`;
    } else {
      // Native order_details payment — card is still visible in chat
      nudgeMsg += `\n\n👆 Scroll up and tap *"Review and Pay"* to complete payment.`;
    }
    nudgeMsg += `\n\n_Reply *"cod"* to switch to Cash on Delivery_\n_Reply *"cancel"* to cancel this order_`;
    await sendWhatsApp(phoneId, token, buildText(waId, nudgeMsg));
    return;
  }

  // No pending order found — payment might have come through, reset to idle
  await updateSession(db, waId, 'idle', '[]', 0);
  return handleIdle(context, session, user, msg, waId, phoneId, token, db);
}

// ─── RAZORPAY PAYMENT LINK CREATION ─────────────────────────────
async function createRazorpayPaymentLink(context, { amount, orderCode, orderId, customerName, customerPhone, cart, discount }) {
  const keyId = context.env.RAZORPAY_KEY_ID;
  const keySecret = context.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error('Razorpay credentials not configured');
    return null;
  }

  const itemDescription = cart.map(c => `${c.qty}x ${c.name}`).join(', ');
  const description = itemDescription.length > 250 ? itemDescription.slice(0, 247) + '...' : itemDescription;

  // Callback URL — customer's browser redirects here after payment (GET)
  const callbackUrl = `https://nawabi-chai-house-sit.pages.dev/api/whatsapp?action=razorpay-callback`;

  try {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${keyId}:${keySecret}`),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // Razorpay uses paise
        currency: 'INR',
        description: `NCH ${orderCode}: ${description}`,
        customer: {
          name: customerName,
          contact: customerPhone,
        },
        notify: { sms: false, email: false, whatsapp: false }, // We handle notification ourselves
        callback_url: callbackUrl,
        callback_method: 'get',
        notes: {
          order_code: orderCode,
          order_id: String(orderId),
          source: 'whatsapp_bot',
        },
        options: {
          checkout: {
            name: 'Nawabi Chai House',
            description: `Order ${orderCode}`,
            prefill: {
              method: 'upi',
            },
          },
        },
        expire_by: Math.floor(Date.now() / 1000) + (20 * 60), // 20 min expiry (Razorpay requires strictly >15 min)
        reminder_enable: false,
        upi_link: true, // Creates a direct UPI intent link
      }),
    });

    const responseText = await res.text();
    if (!res.ok) {
      console.error(`Razorpay API error: ${res.status} — ${responseText}`);
      return null;
    }

    const data = JSON.parse(responseText);
    console.log(`Razorpay Payment Link created: ${data.id} → ${data.short_url}`);
    return data;
  } catch (error) {
    console.error('Razorpay Payment Link error:', error.message);
    return null;
  }
}

// ─── RAZORPAY WEBHOOK HANDLER ───────────────────────────────────
async function handleRazorpayWebhook(context, corsHeaders) {
  try {
    const db = context.env.DB;
    const phoneId = context.env.WA_PHONE_ID;
    const token = context.env.WA_ACCESS_TOKEN;

    const body = await context.request.json();
    const event = body.event;

    console.log('Razorpay webhook received:', event, JSON.stringify(body).slice(0, 500));

    // We care about payment.captured and payment_link.paid
    if (event === 'payment_link.paid') {
      const paymentLink = body.payload?.payment_link?.entity;
      const payment = body.payload?.payment?.entity;

      if (!paymentLink) {
        console.error('No payment_link entity in webhook');
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      const razorpayLinkId = paymentLink.id;
      const razorpayPaymentId = payment?.id || null;
      const orderCode = paymentLink.notes?.order_code;
      const orderId = paymentLink.notes?.order_id;

      // Find the order by razorpay_link_id
      let order = await db.prepare('SELECT * FROM wa_orders WHERE razorpay_link_id = ?').bind(razorpayLinkId).first();

      // Fallback: find by order_id from notes
      if (!order && orderId) {
        order = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(parseInt(orderId)).first();
      }

      if (!order) {
        console.error('Order not found for Razorpay link:', razorpayLinkId);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // Already processed?
      if (order.payment_status === 'paid') {
        console.log('Order already paid:', order.order_code);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // Update order: payment confirmed!
      const now = new Date().toISOString();
      await db.prepare('UPDATE wa_orders SET payment_status = ?, razorpay_payment_id = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind('paid', razorpayPaymentId, 'confirmed', now, order.id).run();

      // Load user for Odoo order creation
      const user = await db.prepare('SELECT * FROM wa_users WHERE wa_id = ?').bind(order.wa_id).first();
      const cart = JSON.parse(order.items);

      // Update user stats NOW (deferred from order creation to avoid inflating on abandoned UPI)
      await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?')
        .bind(order.discount, order.id, order.total, order.wa_id).run();

      // Create Odoo POS order
      const odooResult = await createOdooOrder(
        context, order.order_code, cart, order.total, order.discount, 'upi',
        order.wa_id, user?.name, user?.phone, order.delivery_address,
        order.delivery_lat, order.delivery_lng, order.delivery_distance_m,
        order.runner_name, user?.business_type
      );

      // Send confirmation to customer via WhatsApp
      const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
      let confirmMsg = `✅ *Payment received! Order ${order.order_code} confirmed!*\n\n${itemLines}`;
      if (order.discount > 0) {
        const freeCount = Math.round(order.discount / 15);
        confirmMsg += `\n🎁 ${freeCount}x FREE Irani Chai — -₹${order.discount}`;
      }
      confirmMsg += `\n\n💰 *Total: ₹${order.total}* (UPI ✓ Paid)`;
      confirmMsg += `\n📍 ${order.delivery_address || 'Location saved'}`;
      confirmMsg += `\n🏃 Runner: ${order.runner_name}`;
      confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
      if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

      await sendWhatsApp(phoneId, token, buildText(order.wa_id, confirmMsg));

      // Update session back to order_placed
      await updateSession(db, order.wa_id, 'order_placed', '[]', 0);

      console.log(`Payment confirmed for ${order.order_code}: ₹${order.total}`);
    }

    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
  } catch (error) {
    console.error('Razorpay webhook error:', error.message, error.stack);
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
  }
}

// ─── RAZORPAY CALLBACK (GET redirect after payment) ─────────────
async function handleRazorpayCallback(context, url, corsHeaders) {
  const razorpayPaymentId = url.searchParams.get('razorpay_payment_id');
  const razorpayPaymentLinkId = url.searchParams.get('razorpay_payment_link_id');
  const razorpayPaymentLinkStatus = url.searchParams.get('razorpay_payment_link_status');

  const db = context.env.DB;
  const phoneId = context.env.WA_PHONE_ID;
  const token = context.env.WA_ACCESS_TOKEN;

  if (razorpayPaymentLinkStatus === 'paid' && razorpayPaymentLinkId) {
    // Find the order
    const order = await db.prepare('SELECT * FROM wa_orders WHERE razorpay_link_id = ?').bind(razorpayPaymentLinkId).first();

    if (order && order.payment_status !== 'paid') {
      const now = new Date().toISOString();
      await db.prepare('UPDATE wa_orders SET payment_status = ?, razorpay_payment_id = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind('paid', razorpayPaymentId, 'confirmed', now, order.id).run();

      const user = await db.prepare('SELECT * FROM wa_users WHERE wa_id = ?').bind(order.wa_id).first();
      const cart = JSON.parse(order.items);

      // Update user stats NOW (deferred from order creation to avoid inflating on abandoned UPI)
      await db.prepare('UPDATE wa_users SET first_order_redeemed = CASE WHEN ? > 0 THEN 1 ELSE first_order_redeemed END, last_order_id = ?, total_orders = total_orders + 1, total_spent = total_spent + ? WHERE wa_id = ?')
        .bind(order.discount, order.id, order.total, order.wa_id).run();

      // Create Odoo POS order
      const odooResult = await createOdooOrder(
        context, order.order_code, cart, order.total, order.discount, 'upi',
        order.wa_id, user?.name, user?.phone, order.delivery_address,
        order.delivery_lat, order.delivery_lng, order.delivery_distance_m,
        order.runner_name, user?.business_type
      );

      // Send WhatsApp confirmation
      const itemLines = cart.map(c => `${c.qty}x ${c.name} — ₹${c.price * c.qty}`).join('\n');
      let confirmMsg = `✅ *Payment received! Order ${order.order_code} confirmed!*\n\n${itemLines}`;
      if (order.discount > 0) {
        const freeCount = Math.round(order.discount / 15);
        confirmMsg += `\n🎁 ${freeCount}x FREE Irani Chai — -₹${order.discount}`;
      }
      confirmMsg += `\n\n💰 *Total: ₹${order.total}* (UPI ✓ Paid)`;
      confirmMsg += `\n📍 ${order.delivery_address || 'Location saved'}`;
      confirmMsg += `\n🏃 Runner: ${order.runner_name}`;
      confirmMsg += `\n⏱️ *Arriving in ~5 minutes!*`;
      if (odooResult) confirmMsg += `\n🧾 POS: ${odooResult.name}`;

      await sendWhatsApp(phoneId, token, buildText(order.wa_id, confirmMsg));
      await updateSession(db, order.wa_id, 'order_placed', '[]', 0);
    }
  }

  // Redirect customer to a thank you page
  const thankYouHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment Received — Nawabi Chai House</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#1a2234;border-radius:16px;padding:40px 32px;text-align:center;max-width:360px;width:100%;border:1px solid #2d3a4f}
.check{font-size:64px;margin-bottom:16px}
h1{font-size:22px;margin-bottom:8px;color:#10b981}
p{color:#94a3b8;font-size:14px;line-height:1.6;margin-bottom:20px}
.wa-btn{display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px}
</style></head>
<body><div class="card">
<div class="check">✅</div>
<h1>Payment Received!</h1>
<p>Your order is confirmed and on its way.<br>You'll get updates on WhatsApp.</p>
<a href="https://wa.me/919019575555" class="wa-btn">☕ Back to WhatsApp</a>
</div></body></html>`;

  return new Response(thankYouHtml, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

// ─── SESSION HELPER ───────────────────────────────────────────────
async function updateSession(db, waId, state, cart, cartTotal) {
  await db.prepare('UPDATE wa_sessions SET state = ?, cart = ?, cart_total = ?, updated_at = ? WHERE wa_id = ?')
    .bind(state, cart, cartTotal, new Date().toISOString(), waId).run();
}

// ─── WHATSAPP CLOUD API HELPERS ───────────────────────────────────
async function sendWhatsApp(phoneId, token, payload) {
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('WA API error:', response.status, err);
    }
    return response;
  } catch (e) {
    console.error('WA send error:', e.message);
  }
}

function buildText(to, body) {
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body } };
}

function buildReplyButtons(to, body, buttons) {
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: { type: 'button', body: { text: body }, action: { buttons } }
  };
}

// ── Multi-Product Message (MPM) — Native catalog with cart + qty selector ──
function buildMPM(to, bodyText) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'product_list',
      header: { type: 'text', text: '☕ Nawabi Chai House' },
      body: { text: bodyText },
      footer: { text: 'HKP Road delivery • ~5 min' },
      action: {
        catalog_id: CATALOG_ID,
        sections: [
          {
            title: 'Chai & Beverages',
            product_items: [
              { product_retailer_id: 'NCH-IC' },
              { product_retailer_id: 'NCH-NSC' },
              { product_retailer_id: 'NCH-LT' },
            ]
          },
          {
            title: 'Snacks',
            product_items: [
              { product_retailer_id: 'NCH-BM' },
              { product_retailer_id: 'NCH-OB3' },
              { product_retailer_id: 'NCH-CC' },
            ]
          }
        ]
      }
    }
  };
}

// ── Native Order Details Payment Message — "Review and Pay" inside WhatsApp ──
// Uses Razorpay Payment Gateway mode via WhatsApp Manager payment_configuration
const PAYMENT_CONFIGURATION = 'nch_razorpay';

function buildOrderDetailsPayment(to, orderCode, cart, total, discount) {
  const items = cart.map(c => ({
    retailer_id: c.code,
    name: c.name,
    amount: { value: Math.round(c.price * 100), offset: 100 },
    quantity: c.qty,
  }));

  const subtotal = cart.reduce((sum, c) => sum + (c.price * c.qty), 0);

  const orderObj = {
    status: 'pending',
    catalog_id: CATALOG_ID,
    items,
    subtotal: { value: Math.round(subtotal * 100), offset: 100 },
  };

  if (discount > 0) {
    orderObj.discount = {
      value: Math.round(discount * 100),
      offset: 100,
      description: 'First order — 2 FREE Irani Chai',
    };
  }

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'order_details',
      body: { text: `☕ Order ${orderCode}\n\nTap below to pay ₹${total}` },
      footer: { text: 'Nawabi Chai House • HKP Road' },
      action: {
        name: 'review_and_pay',
        parameters: {
          reference_id: orderCode,
          type: 'digital-goods',
          payment_configuration: PAYMENT_CONFIGURATION,
          payment_type: 'payment_gateway:razorpay',
          currency: 'INR',
          total_amount: { value: Math.round(total * 100), offset: 100 },
          order: orderObj,
        }
      }
    }
  };
}

// ── List Message — up to 10 items in sections ──
function buildListMessage(to, headerText, bodyText, buttonText, sections) {
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: bodyText },
      footer: { text: 'Nawabi Chai House • HKP Road' },
      action: {
        button: buttonText.slice(0, 20),
        sections: sections.map(s => ({
          title: s.title,
          rows: s.rows.map(r => ({
            id: r.id,
            title: (r.title || '').slice(0, 24),
            description: (r.description || '').slice(0, 72),
          }))
        }))
      }
    }
  };
}

function buildLocationRequest(to, body) {
  return {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'location_request_message',
      body: { text: body },
      action: { name: 'send_location' }
    }
  };
}

// ─── GOOGLE PLACES NEARBY SEARCH ──────────────────────────────────
// Searches for ALL businesses near the customer's pin using Google Places API (New)
// Strategy: 20m tight radius with POPULARITY ranking
// 20m = pinpoint accuracy — only shows businesses right at the pin
// POPULARITY within that tiny radius puts well-known outlets first
// TYPE STRATEGY: NO includedTypes + excludedPrimaryTypes (remove noise)
// Returns up to 20 nearby places sorted by popularity within 20m of pin
async function searchNearbyPlaces(lat, lng, apiKey) {
  const requestBody = {
    excludedPrimaryTypes: [
      'atm', 'parking', 'bus_stop', 'bus_station', 'train_station',
      'subway_station', 'transit_station', 'transit_depot', 'taxi_stand',
      'gas_station', 'electric_vehicle_charging_station',
      'apartment_building', 'apartment_complex', 'condominium_complex', 'housing_complex',
      'park', 'playground', 'dog_park', 'national_park', 'state_park',
      'hiking_area', 'beach', 'campground', 'marina', 'ski_resort',
      'church', 'hindu_temple', 'mosque', 'synagogue',
      'fire_station', 'police', 'cemetery', 'city_hall', 'courthouse',
      'school', 'primary_school', 'secondary_school', 'preschool',
    ],
    maxResultCount: 20,
    rankPreference: 'POPULARITY',
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 20.0 // 20m — pinpoint, only businesses right at the dropped pin
      }
    }
  };

  const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryType,places.primaryTypeDisplayName,places.businessStatus,places.formattedAddress,places.shortFormattedAddress,places.location,places.types'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Google Places API error:', response.status, errText);
    return [];
  }

  const data = await response.json();
  const places = (data.places || []).map((p, i) => ({
    index: i,
    name: p.displayName?.text || 'Unknown',
    address: p.shortFormattedAddress || p.formattedAddress || '',
    primaryType: p.primaryTypeDisplayName?.text || '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    types: p.types || [],
    businessStatus: p.businessStatus || 'OPERATIONAL',
  }));

  // Filter out permanently closed businesses
  return places.filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p, i) => ({ ...p, index: i }));
}

// ─── GOOGLE PLACES TEXT SEARCH (FALLBACK) ────────────────────────
// When nearby search doesn't show the customer's business, they type the name.
// We search by name + location bias to find it on Google Maps.
// Returns up to 5 matching places near the pin.
async function searchPlacesByName(query, lat, lng, apiKey) {
  const requestBody = {
    textQuery: query,
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: 500.0 // Wider radius for name search — business might be listed at a slightly different coordinate
      }
    },
    rankPreference: 'DISTANCE',
    pageSize: 5,
    languageCode: 'en',
    regionCode: 'IN',
  };

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.primaryTypeDisplayName,places.businessStatus,places.formattedAddress,places.shortFormattedAddress,places.location'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    console.error('Google Text Search error:', response.status, await response.text());
    return [];
  }

  const data = await response.json();
  return (data.places || [])
    .filter(p => (p.businessStatus || 'OPERATIONAL') !== 'CLOSED_PERMANENTLY')
    .map((p, i) => ({
      index: i,
      name: p.displayName?.text || 'Unknown',
      address: p.shortFormattedAddress || p.formattedAddress || '',
      primaryType: p.primaryTypeDisplayName?.text || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
    }));
}

// ── WhatsApp Interactive List: Nearby Places for Location Confirmation ──
// Shows up to 5 places + optional "Show More" + "Not listed here" option
function buildLocationConfirmList(to, places, hasMore, distanceFromNCH) {
  const rows = places.map(p => {
    // Show type + address in description: "Clothing Store — 123 HKP Road"
    const typeLabel = p.primaryType || '';
    const addr = p.address || '';
    let description;
    if (typeLabel && addr) {
      description = `${typeLabel} — ${addr}`.slice(0, 72);
    } else {
      description = (typeLabel || addr).slice(0, 72);
    }
    return {
      id: `loc_place_${p.index}`,
      title: p.name.slice(0, 24), // WhatsApp max 24 chars for title
      description
    };
  });

  // Add "Show more listings" if there are more results
  if (hasMore) {
    rows.push({
      id: 'loc_show_more',
      title: '🔍 Show more',
      description: 'See more nearby businesses'
    });
  }

  // Always add "Not listed" option
  rows.push({
    id: 'loc_not_here',
    title: '❌ Not listed here',
    description: 'Enter your business name manually'
  });

  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '📍 Confirm your location' },
      body: {
        text: `We found these businesses near your pin (${distanceFromNCH}m from NCH).\n\nSelect your shop/business so our runner delivers to the right place:`
      },
      footer: { text: 'Nawabi Chai House • HKP Road' },
      action: {
        button: 'Select your place',
        sections: [{
          title: 'Nearby Businesses',
          rows
        }]
      }
    }
  };
}

// ─── HAVERSINE DISTANCE (meters) ──────────────────────────────────
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── ODOO POS ORDER CREATION ──────────────────────────────────────
async function createOdooOrder(context, orderCode, cart, total, discount, paymentMethod, waId, userName, phone, deliveryAddress, deliveryLat, deliveryLng, deliveryDistance, runnerName, businessType) {
  const apiKey = context.env.ODOO_API_KEY;
  if (!apiKey) { console.error('ODOO_API_KEY not set'); return null; }

  try {
    const sessionRes = await odooRPC(apiKey, 'pos.session', 'search_read',
      [[['config_id', '=', POS_CONFIG_ID], ['state', '=', 'opened']]],
      { fields: ['id', 'name'], limit: 1 });
    if (!sessionRes || sessionRes.length === 0) {
      console.error('No active session for NCH-Delivery POS');
      return null;
    }
    const sessionId = sessionRes[0].id;

    const lines = cart.map(item => [0, 0, {
      product_id: item.odooId,
      qty: item.qty,
      price_unit: item.price,
      price_subtotal: item.price * item.qty,
      price_subtotal_incl: item.price * item.qty,
      discount: 0,
      tax_ids: [[6, 0, []]],
      full_product_name: item.name,
    }]);

    const mapsLink = deliveryLat ? `https://maps.google.com/?q=${deliveryLat},${deliveryLng}` : '';
    const customerPhone = phone || waId;
    const formattedPhone = customerPhone.startsWith('91') ? '+' + customerPhone : customerPhone;
    const noteLines = [
      `📱 WHATSAPP ORDER: ${orderCode}`,
      `👤 ${userName || 'Customer'} — ${formattedPhone}`,
      businessType ? `🏢 ${businessType}` : '',
      `📍 ${deliveryAddress || 'Location shared'} (${deliveryDistance || '?'}m)`,
      mapsLink ? `🗺️ ${mapsLink}` : '',
      `🏃 Runner: ${runnerName}`,
      `💰 ${paymentMethod === 'cod' ? 'CASH ON DELIVERY' : 'UPI (Pre-paid)'}`,
      discount > 0 ? `🎁 FREE Irani Chai applied (-₹${discount})` : '',
    ].filter(Boolean).join('\n');

    const odooPaymentMethodId = paymentMethod === 'cod' ? PAYMENT_METHOD_COD : PAYMENT_METHOD_UPI;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const orderId = await odooRPC(apiKey, 'pos.order', 'create', [{
      session_id: sessionId,
      config_id: POS_CONFIG_ID,
      pricelist_id: PRICELIST_ID,
      amount_total: total,
      amount_paid: total,
      amount_tax: 0,
      amount_return: 0,
      date_order: now,
      lines: lines,
      internal_note: noteLines,
      state: 'draft',
    }]);

    if (!orderId) { console.error('Failed to create POS order'); return null; }

    await odooRPC(apiKey, 'pos.payment', 'create', [{
      pos_order_id: orderId,
      payment_method_id: odooPaymentMethodId,
      amount: total,
      payment_date: now,
      session_id: sessionId,
    }]);

    await odooRPC(apiKey, 'pos.order', 'action_pos_order_paid', [[orderId]]);

    const orderData = await odooRPC(apiKey, 'pos.order', 'search_read',
      [[['id', '=', orderId]]], { fields: ['name'] });
    const odooOrderName = orderData?.[0]?.name || `Order #${orderId}`;

    console.log(`Odoo POS order created: ${odooOrderName} (ID: ${orderId})`);
    return { id: orderId, name: odooOrderName };
  } catch (error) {
    console.error('Odoo order creation error:', error.message);
    return null;
  }
}

async function odooRPC(apiKey, model, method, args, kwargs) {
  const payload = {
    jsonrpc: '2.0', method: 'call', id: 1,
    params: { service: 'object', method: 'execute_kw',
      args: [ODOO_DB, ODOO_UID, apiKey, model, method, ...args, kwargs || {}] }
  };
  const res = await fetch(ODOO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.error) {
    console.error('Odoo RPC error:', JSON.stringify(data.error.data?.message || data.error.message));
    return null;
  }
  return data.result;
}

// ─── DASHBOARD API ────────────────────────────────────────────────
async function handleDashboardAPI(context, action, url, corsHeaders) {
  const db = context.env.DB;

  try {
    // Temporary: Odoo query for POS config extraction
    if (action === 'odoo-query') {
      const model = url.searchParams.get('model');
      const fields = url.searchParams.get('fields');
      const domain = url.searchParams.get('domain') || '[]';
      if (!model || !fields) return new Response(JSON.stringify({error:'need model and fields'}), {headers: corsHeaders});
      const ODOO_URL = 'https://ops.hamzahotel.com/jsonrpc';
      const payload = {jsonrpc:'2.0',method:'call',id:1,params:{service:'object',method:'execute_kw',args:['main',2,context.env.ODOO_API_KEY,model,'search_read',JSON.parse(domain),{fields:fields.split(',')}]}};
      const res = await fetch(ODOO_URL, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const data = await res.json();
      return new Response(JSON.stringify(data?.result || data), {headers: corsHeaders});
    }

    if (action === 'orders') {
      const status = url.searchParams.get('status');
      let query = 'SELECT * FROM wa_orders';
      const params = [];

      if (status && status !== 'all') {
        query += ' WHERE status = ?';
        params.push(status);
      } else {
        query += " WHERE created_at >= date('now', 'start of day')";
      }
      query += ' ORDER BY created_at DESC LIMIT 100';

      const result = params.length > 0
        ? await db.prepare(query).bind(...params).all()
        : await db.prepare(query).all();

      return new Response(JSON.stringify({ success: true, orders: result.results || [] }), { headers: corsHeaders });
    }

    if (action === 'stats') {
      const today = await db.prepare("SELECT COUNT(*) as orders, COALESCE(SUM(total), 0) as revenue, COUNT(DISTINCT wa_id) as customers FROM wa_orders WHERE created_at >= date('now', 'start of day')").first();
      const newCustomers = await db.prepare("SELECT COUNT(*) as cnt FROM wa_users WHERE created_at >= date('now', 'start of day')").first();
      const delivered = await db.prepare("SELECT COUNT(*) as cnt, AVG(CAST((julianday(delivered_at) - julianday(created_at)) * 1440 AS INTEGER)) as avg_mins FROM wa_orders WHERE status = 'delivered' AND created_at >= date('now', 'start of day')").first();

      return new Response(JSON.stringify({
        success: true,
        stats: {
          totalOrders: today?.orders || 0,
          revenue: today?.revenue || 0,
          uniqueCustomers: today?.customers || 0,
          newCustomers: newCustomers?.cnt || 0,
          delivered: delivered?.cnt || 0,
          avgDeliveryMins: delivered?.avg_mins ? Math.round(delivered.avg_mins) : null
        }
      }), { headers: corsHeaders });
    }

    if (action === 'update-status' && context.request.method === 'POST') {
      const body = await context.request.json();
      const { orderId, status } = body;
      if (!orderId || !status) {
        return new Response(JSON.stringify({ success: false, error: 'Missing orderId or status' }), { status: 400, headers: corsHeaders });
      }

      const validStatuses = ['confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return new Response(JSON.stringify({ success: false, error: 'Invalid status' }), { status: 400, headers: corsHeaders });
      }

      const now = new Date().toISOString();
      const deliveredAt = status === 'delivered' ? now : null;

      await db.prepare('UPDATE wa_orders SET status = ?, updated_at = ?, delivered_at = COALESCE(?, delivered_at) WHERE id = ?')
        .bind(status, now, deliveredAt, orderId).run();

      const order = await db.prepare('SELECT * FROM wa_orders WHERE id = ?').bind(orderId).first();
      if (order) {
        const phoneId = context.env.WA_PHONE_ID;
        const token = context.env.WA_ACCESS_TOKEN;

        let notifyMsg = null;
        if (status === 'preparing') notifyMsg = `🍵 Your order *${order.order_code}* is being prepared!`;
        if (status === 'out_for_delivery') notifyMsg = `🏃 *${order.order_code}* is out for delivery! ${order.runner_name} is on the way.`;
        if (status === 'delivered') notifyMsg = `✅ *${order.order_code}* delivered! Enjoy your chai! ☕\n\nOrder again anytime — just message us!`;
        if (status === 'cancelled') notifyMsg = `❌ Sorry, your order *${order.order_code}* has been cancelled. Please contact us if you have questions.`;

        if (notifyMsg) {
          await sendWhatsApp(phoneId, token, buildText(order.wa_id, notifyMsg));
        }
      }

      return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    }

    // ── Reset user (for testing) ──
    if (action === 'reset-user' && context.request.method === 'POST') {
      const body = await context.request.json();
      const { phone } = body;
      if (!phone) return new Response(JSON.stringify({ success: false, error: 'phone required' }), { status: 400, headers: corsHeaders });
      // Normalize: add 91 prefix if not present
      const waId = phone.startsWith('91') ? phone : '91' + phone;
      await db.prepare('DELETE FROM wa_users WHERE wa_id = ?').bind(waId).run();
      await db.prepare('DELETE FROM wa_sessions WHERE wa_id = ?').bind(waId).run();
      return new Response(JSON.stringify({ success: true, message: `User ${waId} reset — will be treated as brand new user` }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: false, error: 'Unknown action' }), { status: 400, headers: corsHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: corsHeaders });
  }
}
