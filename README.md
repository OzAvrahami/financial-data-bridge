# Cal Credit Card Transaction Automation

אוטומציה לשליפת עסקאות כרטיסי אשראי מאתר Cal Online באמצעות Playwright.

## תכונות

- 🔐 התחברות אוטומטית לאתר Cal Online
- 📅 סינון עסקאות לפי טווח תאריכים (ברירת מחדל: 4 ימים אחרונים)
- 📊 שליפה אוטומטית של כל פרטי העסקאות
- 💾 ייצוא לקובץ JSON
- 🎯 חילוץ מדויק של כל הנתונים מכל עסקה (כולל עסקאות בדולר)

## נתונים שנשלפים

עבור כל עסקה:
- **תאריך העסקה** - תאריך ושעת ביצוע העסקה
- **שם בית העסק** - שם העסק בו בוצעה העסקה
- **סכום העסקה** - הסכום המקורי (בדולר או שקלים)
- **סוג העסקה** - רגיל/תשלומים/וכו'
- **כרטיס** - שם הכרטיס (4 ספרות אחרונות)
- **ענף בית העסק** - קטגוריה (מסעדות, מזון, וכו')
- **תאריך חיוב** - מועד החיוב בפועל (אם קיים)
- **סכום חיוב** - סכום החיוב בשקלים (אם שונה מסכום העסקה)

## התקנה

1. שכפל את הפרויקט:
```bash
git clone <repository-url>
cd automation-cal
```

2. התקן תלויות:
```bash
npm install
```

3. צור קובץ `.env` על בסיס `.env.example`:
```bash
cp .env.example .env
```

4. ערוך את קובץ `.env` והוסף את פרטי ההתחברות שלך:
```
CAL_USERNAME=your_username_here
CAL_PASSWORD=your_password_here
```

## שימוש

הרץ את הסקריפט:
```bash
npm start
```

או:
```bash
node fetch-transactions.js
```

הסקריפט יבצע:
1. התחברות לאתר Cal Online
2. ניווט לדף "עסקאות לפי תאריך ביצוע"
3. הפעלת סינון ל-4 ימים אחרונים
4. שליפת כל העסקאות (לוחץ על כל עסקה ומחלץ את הפרטים המלאים)
5. שמירה לקובץ JSON בתיקיית `exports/`

**קובץ הפלט:** `exports/cal_YYYY-MM-DD.json`

## התאמה אישית

### שינוי טווח התאריכים

בקובץ [fetch-transactions.js](fetch-transactions.js), שנה את השורה:
```javascript
await client.applyDateFilter(4); // 4 days back
```

למשל, עבור 7 ימים:
```javascript
await client.applyDateFilter(7);
```

### הרצה במצב headless

בקובץ [fetch-transactions.js](fetch-transactions.js):
```javascript
await client.initialize({
  headless: true,  // true = רקע ללא חלון דפדפן
  slowMo: 50,
});
```

## מבנה הפרויקט

```
automation-cal/
├── fetch-transactions.js    # סקריפט ראשי להרצה
├── utils/
│   └── calClient.js         # מחלקה לניהול אוטומציה
├── exports/                 # תיקיית קבצי פלט
├── .env                     # פרטי התחברות (לא נכלל ב-git)
├── .env.example            # דוגמה לקובץ .env
├── package.json            # תלויות הפרויקט
└── README.md               # מסמך זה
```

## דרישות מערכת

- Node.js 14 ומעלה
- Windows/Mac/Linux

## תלויות

- `@playwright/test` - אוטומציית דפדפן
- `dotenv` - ניהול משתני סביבה

## הערות חשובות

- הסקריפט רץ עם דפדפן גלוי (`headless: false`) כדי לאפשר צפייה בתהליך
- העסקאות נשמרות בפורמט JSON עם כל הפרטים
- עסקאות "ממתינות" (הסכום לא סופי) לא יכללו תאריך חיוב או סכום חיוב
- עסקאות בדולר יכללו גם את סכום העסקה המקורי וגם את סכום החיוב בשקלים

## פורמט קובץ הפלט

```json
[
  {
    "transactionDate": "2025-11-22",
    "cardName": "ויזה5304",
    "businessName": "WOLT",
    "expenseType": "מסעדות",
    "amount": 129.9,
    "issuer": "CAL",
    "transactionType": "רגיל",
    "details": "",
    "chargeDate": "",
    "chargeAmount": 0
  },
  {
    "transactionDate": "2025-11-21",
    "cardName": "ויזה5304",
    "businessName": "MyFunded Futures",
    "expenseType": "",
    "amount": 77,
    "issuer": "CAL",
    "transactionType": "רגילה",
    "details": "",
    "chargeDate": "2025-12-02",
    "chargeAmount": 260.14
  }
]
```

## פתרון בעיות

### הסקריפט תקוע בהתחברות
- בדוק שפרטי ההתחברות נכונים בקובץ `.env`
- ייתכן שנדרש אימות דו-שלבי - בצע אותו ידנית בדפדפן הגלוי

### לא נמצאו עסקאות
- בדוק שיש עסקאות בטווח התאריכים המבוקש (ברירת מחדל: 4 ימים)
- נסה להגדיל את טווח התאריכים

### העסקאות לא נשלפות כראוי
- הרץ במצב `headless: false` כדי לראות מה קורה
- בדוק את הקונסולה לשגיאות

## אבטחה

⚠️ **חשוב:**
- אל תשתף את קובץ `.env` עם אחרים
- אל תעלה את קובץ `.env` ל-Git
- השתמש באוטומציה באופן סביר

## רישיון

MIT

## תרומה

Pull Requests מתקבלים בברכה!
