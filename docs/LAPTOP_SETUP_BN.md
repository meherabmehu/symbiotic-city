# পুরো প্রজেক্ট নিজের ল্যাপটপে নেওয়া — ধাপে ধাপে

এই গাইডটা লেখা হয়েছে **যাচাই করে**: একটা নতুন ফোল্ডারে GitHub থেকে সদ্য clone
করে, শূন্য থেকে venv বানিয়ে, npm install করে, `./scripts/dev.sh` দিয়ে দুটো সার্ভার
চালু করে দেখানো হয়েছে যে সব কাজ করে। যে কমান্ডগুলো নিচে আছে, সেগুলো হুবহু ওই
পরীক্ষায় চালানো হয়েছে।

**কী কী যাচাই হয়েছে:**

| ধাপ | ফলাফল |
| --- | --- |
| `git clone` (পাবলিক, লগইন ছাড়া) | `e909d0a` — নতুন কোড সব এসেছে |
| venv + `pip install` | সফল |
| `npm install` | সফল |
| `.env` ছাড়া চালু (ডিফল্ট SQLite) | ২৩টা asset, ৫টা zone নিজে থেকে সিড হয়েছে |
| `./scripts/dev.sh` | API `:8000` উঠেছে, আসল ডেটা দিয়েছে (PS-02 = 84.3) |
| `python scripts/smoke.py` | সব চেক পাশ |
| `./scripts/verify.sh` | **269 passed, 10 skipped**, typecheck ও build পাশ |
| `alembic upgrade head` | দুটো migration-ই চলেছে, whatif টেবিল তৈরি |

ধরুন আপনি কিছুই ইনস্টল করা নেই এমন একটা ল্যাপটপে বসে আছেন।

---

## ০ · যা যা লাগবে

| জিনিস | ভার্সন | কেন |
| --- | --- | --- |
| Python | **৩.১১ বা তার বেশি** | backend (FastAPI + OR-Tools) |
| Node.js | **২০ বা তার বেশি** | frontend (Next.js 15 + React 19) |
| Git | যেকোনো | কোড নামাতে |
| ইন্টারনেট | একবারই | pip আর npm প্যাকেজ নামাতে |

**ডাটাবেজ সার্ভার লাগবে না।** ডিফল্টে SQLite ব্যবহার হয় — একটাই ফাইল, আলাদা করে
কিছু ইনস্টল বা চালু করতে হয় না। PostgreSQL চাইলে সেটাও সম্ভব, কিন্তু শুরু করার
জন্য দরকার নেই।

ভার্সন দেখে নিন:

```bash
python3 --version     # Python 3.11.x বা বেশি
node --version        # v20.x বা বেশি
npm --version
```

> **Windows ব্যবহার করলে** — পুরো সেকশন আছে নিচে: **[উইন্ডোজ / PowerShell](#উইন্ডোজ--powershell)**।
> সংক্ষেপে: PowerShell 5.1-এ `&&` চলে না, তাই নিচের bash কমান্ডগুলো হুবহু পেস্ট করলে
> কাজ করবে না। এর জন্য আলাদা স্ক্রিপ্ট `scripts\dev.ps1` দেওয়া আছে।

---

## ১ · কোড নামান

```bash
git clone https://github.com/meherabmehu/symbiotic-city.git
cd symbiotic-city
```

রিপোটা পাবলিক, তাই কোনো লগইন বা টোকেন লাগবে না।

নিশ্চিত হয়ে নিন আপনি ঠিক জায়গায় আছেন — এটা দেখলে বুঝবেন সবশেষ কোড পেয়েছেন:

```bash
git log --oneline -1
# e909d0a writing down what was measured
```

---

## ২ · Backend ইনস্টল (Python)

প্রজেক্টের **রুট ফোল্ডারে** থাকতে থাকতেই (যেখানে `README.md` আছে):

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
```

প্রথমবার ২–৪ মিনিট লাগতে পারে, কারণ OR-Tools (অপ্টিমাইজারের সলভার) বড় প্যাকেজ।
শেষে কোনো লাল `ERROR` না দেখলেই হয়ে গেছে।

> **`.venv` কেন রুটে?** কারণ প্রজেক্টের `scripts/dev.sh` আর `scripts/verify.sh`
> দুটোই `.venv/bin/python` খোঁজে রুট থেকে। অন্য জায়গায় বানালে স্ক্রিপ্ট চলবে না।

---

## ৩ · Frontend ইনস্টল (Node)

```bash
cd frontend
npm install
cd ..
```

`cd ..` টা ভুলবেন না — এতে আবার রুটে ফিরে আসবেন, পরের ধাপের জন্য।

---

## ৪ · কনফিগার (ঐচ্ছিক)

**এই ধাপটা না করলেও চলবে।** সব সেটিংয়েরই কাজ-করা ডিফল্ট আছে।

তবে নিজের কনফিগ রাখতে চাইলে:

```bash
cp .env.example .env
```

`.env` ফাইলটা রুটে রাখতে হবে (backend ফোল্ডারে রাখলেও কাজ করে)। পছন্দমতো বদলাতে
পারেন:

| ভেরিয়েবল | ডিফল্ট | মানে |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:///backend/data/symbiotic_city.db` | ডাটাবেজ। PostgreSQL চাইলে এখানে বদলান। |
| `SEED_DEMO_DATA` | `1` | চালু করলে Aurora Vale শহরের ডেমো ডেটা বসে (একবারই, বারবার চালালেও ডুপ্লিকেট হয় না) |
| `BACKEND_URL` | `http://127.0.0.1:8000` | frontend কোন পোর্টে API খুঁজবে |
| `SECRET_KEY` | ডেভ ডিফল্ট | সেশন সাইন করে। **শুধু** `ENVIRONMENT=production` করলে এটা বদলাতে বাধ্য করে |

> **`DATABASE_URL` লেখার ধরন:** এখানে relative path **রিপো রুটের সাপেক্ষে** ধরা হয়,
> যে ফোল্ডার থেকে কমান্ড চালাচ্ছেন তার সাপেক্ষে নয়। এই একটা জিনিস মানুষকে সবচেয়ে
> বেশি বিভ্রান্ত করে, তাই আলাদা করে বললাম।

---

## ৫ · চালু করুন

```bash
./scripts/dev.sh
```

একই কমান্ডে দুটো সার্ভার ওঠে:

```
→ API   http://127.0.0.1:8000/api  (docs at /api/docs)
→ Web   http://127.0.0.1:3000
```

এরপর ব্রাউজারে খুলুন: **<http://127.0.0.1:3000>**

বন্ধ করতে টার্মিনালে **Ctrl + C**।

আলাদা করে চালাতে চাইলে:

```bash
./scripts/dev.sh api     # শুধু backend, :8000
./scripts/dev.sh web     # শুধু frontend, :3000
```

> `Permission denied: ./scripts/dev.sh` এলে একবার এটা দিন:
> `chmod +x scripts/*.sh`

---

## ৬ · লগইন

ডেটা সিড হয়ে গেলে এই অ্যাকাউন্টগুলো তৈরি থাকে (সবই কাল্পনিক):

| রোল | ইমেইল | পাসওয়ার্ড | কী করতে পারে |
| --- | --- | --- | --- |
| Super Admin | `admin@symbiotic.city` | `Admin#2026` | সব, ইউজার, সেটিংস, অডিট |
| City Operator | `operator@symbiotic.city` | `Operator#2026` | incident, plan approve, dispatch |
| Field Engineer | `engineer@symbiotic.city` | `Engineer#2026` | নিজের টাস্ক |
| City Analyst | `analyst@symbiotic.city` | `Analyst#2026` | simulate, optimise, export, resilience planning |

লগইন পেজে এক-ক্লিক ডেমো বাটনও আছে (`NEXT_PUBLIC_DEMO_LOGIN=1` থাকলে)।

---

## ৭ · নতুন জিনিসটা কোথায়

সাইডবারে **Infrastructure** গ্রুপে **Resilience Intelligence** — অথবা সরাসরি
<http://127.0.0.1:3000/resilience>।

পাঁচটা ট্যাব:

1. **Exposure** — কোন জোন কত ঝুঁকিতে, কেন (zone map + criticality র‍্যাঙ্কিং)
2. **What-if futures** — দুটো ভবিষ্যৎ পাশাপাশি রেখে তুলনা
3. **Recovery trade-offs** — কোন রিকভারি প্ল্যান কতটা সাইট বাঁচায়
4. **Investment plan** — আগে কী ঠিক করবেন, কত টাকায়, কী লাভ
5. **Time travel** — অতীতের কোনো মুহূর্তে শহর কেমন ছিল

**সবচেয়ে সহজ প্রথম কাজ:** ট্যাব ৩-এ একটা সিমুলেশন রান বেছে **Build frontier**
চাপুন — প্রায় ৫ সেকেন্ড লাগবে, তারপর কয়েকটা প্ল্যান পাশাপাশি দেখবেন।

> Analyst বা Operator দিয়ে লগইন করুন। Field Engineer দিয়ে করলে planning প্যানেলগুলো
> "আপনার রোলে এটা নেই" বার্তা দেখাবে — এটা বাগ নয়, ইচ্ছাকৃত (RBAC)।

---

## ৮ · ঠিকঠাক চলছে কিনা যাচাই

**সবচেয়ে দ্রুত পরীক্ষা** — backend চালু থাকা অবস্থায়, রুট থেকে:

```bash
.venv/bin/python scripts/smoke.py
```

সব লাইনে `PASS` দেখলে বোঝবেন login, সিমুলেশন, অপ্টিমাইজার, ওয়ার্কফ্লো — সব ঠিক।

**পুরো টেস্ট স্যুট** (২৬৯টা টেস্ট, ~২ মিনিট ২০ সেকেন্ড):

```bash
.venv/bin/python -m pytest backend/tests -q
# 269 passed, 10 skipped
```

**সব একসাথে** (টেস্ট + typecheck + build):

```bash
./scripts/verify.sh
```

---

## সমস্যা হলে

| যা দেখছেন | কারণ | সমাধান |
| --- | --- | --- |
| `Python venv not found at .venv` | venv বানানো হয়নি বা রুটে নেই | ধাপ ২ আবার করুন, `.venv` রুটে থাকতে হবে |
| `frontend/node_modules is missing` | `npm install` হয়নি | `cd frontend && npm install` |
| পোর্ট ৩০০০ বা ৮০০০ busy | আগের কোনো সার্ভার এখনো চলছে | `lsof -i :3000` দিয়ে দেখুন, বা `pkill -f "next dev"` |
| লগইন পেজে "Cannot reach API" | backend ওঠেনি | `./scripts/dev.sh api` আলাদা টার্মিনালে চালিয়ে লগ দেখুন |
| ড্যাশবোর্ডে সব শূন্য | ডেটা সিড হয়নি | `.env`-এ `SEED_DEMO_DATA=1` দিন, ডাটাবেজ মুছে আবার চালান |
| ডাটাবেজ পুরো রিসেট করতে চাই | পুরনো ডেটা জমেছে | `rm backend/data/symbiotic_city.db` — পরের বার চালু হলে নতুন করে সিড হবে |
| `Permission denied: ./scripts/dev.sh` | এক্সিকিউট বিট নেই | `chmod +x scripts/*.sh` |
| `npm install` এ error | Node পুরনো | `node --version` দেখুন, ২০+ দরকার |
| PowerShell: `'&&' is not a valid statement separator` | PowerShell 5.1 `&&` চেনে না | `;` এর বদলে এক লাইন করে দিন, বা `.\scripts\dev.ps1 setup` |
| PowerShell: `running scripts is disabled` | Execution Policy | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| Windows: `python3` দিলে Store খোলে | Microsoft Store stub | `python` লিখুন |
| Windows: `.venv/bin/python` পাওয়া যায় না | উইন্ডোজে ফোল্ডার `Scripts` | `.venv\Scripts\python.exe` |

**শূন্য থেকে নতুন করে শুরু করতে:**

```bash
rm -rf .venv frontend/node_modules backend/data
# তারপর ধাপ ২ থেকে আবার
```

---

## PostgreSQL চাইলে (ঐচ্ছিক)

ডিফল্ট SQLite দিয়েই সব কাজ করে। PostgreSQL লাগলে:

```bash
# ডাটাবেজ বানান
createdb symbiotic_city

# .env এ লিখুন
DATABASE_URL=postgresql+psycopg2://আপনার_ইউজার@localhost:5432/symbiotic_city

# স্কিমা বানান
cd backend && ../.venv/bin/python -m alembic upgrade head && cd ..
```

আলাদা করে `alembic` চালানোর দরকার এখানেই — SQLite ব্যবহার করলে backend চালু হওয়ার
সময়েই টেবিলগুলো নিজে থেকে তৈরি হয়ে যায়।

> **কেন PostgreSQL-এ আলাদা করে দেখানো দরকার:** SQLite টেবিল তৈরির সময় foreign key
> যাচাই করে না, PostgreSQL করে। তাই SQLite-এ সব সবুজ দেখিয়ে PostgreSQL-এ ভাঙতে
> পারে — এই প্রজেক্টে একবার ঠিক তাই হয়েছিল। এখন migration টা দুই জায়গাতেই পাশ করে।

---

## কী চালু হচ্ছে কোথায়

| ঠিকানা | কী |
| --- | --- |
| <http://127.0.0.1:3000> | মূল অ্যাপ (এটাই ব্রাউজারে খুলবেন) |
| <http://127.0.0.1:3000/resilience> | নতুন Resilience Intelligence পেজ |
| <http://127.0.0.1:3000/docs> | অ্যাপের ভেতরের মেথডোলজি ও ডেমো স্ক্রিপ্ট |
| <http://127.0.0.1:8000/api/docs> | API-র নিজস্ব (Swagger) ডকুমেন্টেশন |

ব্রাউজার কখনো সরাসরি `:8000`-এ কথা বলে না — সব `/api/...` কল Next.js নিজে backend-এ
পাস করে দেয়। এতে কুকি first-party থাকে, CORS ঝামেলা নেই।

---

## আরও পড়তে চাইলে

| ফাইল | কী আছে |
| --- | --- |
| `docs/SETUP.md` | বিস্তারিত সেটআপ, প্রোডাকশন ডিপ্লয়, দুই-কন্টেইনার পথ |
| `docs/RESILIENCE_INTELLIGENCE_REPORT.md` | ছয়টা নতুন ফিচারের রিপোর্ট, কী যাচাই হয়েছে আর কী হয়নি |
| `docs/DEMO_SCRIPT.md` | ডেমো রেকর্ড করার স্ক্রিপ্ট |
| `docs/DEEP_DEBUGGING_REPORT.md` | যে যে বাগ ধরা পড়েছিল ও কীভাবে |

---

## উইন্ডোজ / PowerShell

### কেন আপনার কমান্ডগুলো কাজ করেনি

```
The token '&&' is not a valid statement separator in this version.
```

PowerShell **5.1** (Windows 10/11-এ ডিফল্ট) `&&` চেনে না — এটা PowerShell 7+ এর
জিনিস। আর এটা **parse error**, তাই লাইনটা একেবারেই চলেনি: `.venv` এখনো তৈরি হয়নি।
পুরো লাইনটা একসাথে ব্যর্থ হয়েছে, প্রথম অংশটা আলাদা করে চালেনি।

**সবচেয়ে সহজ সমাধান** — নিচের এক লাইন:

```powershell
.\scripts\dev.ps1 setup
```

এটা venv বানায়, backend আর frontend দুটোরই প্যাকেজ ইনস্টল করে।

এরপর চালু করতে:

```powershell
.\scripts\dev.ps1
```

### যদি "running scripts is disabled" আসে

এটা স্ক্রিপ্টের সমস্যা নয়, উইন্ডোজের ডিফল্ট Execution Policy। দুইটা উপায়:

```powershell
# শুধু এই বার চালাতে
powershell -ExecutionPolicy Bypass -File .\scripts\dev.ps1

# অথবা একবারের জন্য নিজের ইউজারের অনুমতি দিয়ে দিন (dev মেশিনে স্বাভাবিক)
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### হাতে করতে চাইলে (স্ক্রিপ্ট ছাড়া)

PowerShell 5.1-এ `&&` এর বদলে **`;`** ব্যবহার করুন — তবে সাবধান: `;` আগের কমান্ড
ব্যর্থ হলেও পরেরটা চালিয়ে যায়। নিরাপদে করতে একটা একটা করে লাইন দিন:

```powershell
python -m venv .venv

.\.venv\Scripts\Activate.ps1

pip install -r backend\requirements.txt

cd frontend
npm install
cd ..

python backend\run.py
```

> **`python3` নয়, `python`।** উইন্ডোজে সাধারণত `python3.exe` থাকে না। আর
> Microsoft Store-এর `python3` stub খুললে দোকান খোলে, Python চলে না।
>
> **`.venv\Scripts` — `.venv/bin` নয়।** উইন্ডোজে venv-এর ভেতরের ফোল্ডারের নাম
> `Scripts`, আর python-এর নাম `python.exe`, `python3` নয়।

### দুইটা টার্মিনালে চালাতে চাইলে

স্ক্রিপ্ট একসাথে দুটোই চালায়। আলাদা করতে চাইলে:

```powershell
# টার্মিনাল ১
.\scripts\dev.ps1 api

# টার্মিনাল ২
.\scripts\dev.ps1 web
```

তারপর ব্রাউজারে <http://127.0.0.1:3000>।

### উইন্ডোজে যে বাগটা ধরা পড়েছিল

আপনার প্রশ্নের কারণে একটা আসল বাগ পাওয়া গেছে, সেটা ঠিক করা হয়েছে।

`.env.example` কপি করলে `DATABASE_URL` হয় আপেক্ষিক (`sqlite:///./data/...`) — সেটা
ঠিকই কাজ করে। কিন্তু কেউ যদি **পূর্ণ Windows path** দেয়:

```
DATABASE_URL=sqlite:///C:/Users/USER/symbiotic-city/backend/data/symbiotic_city.db
```

তাহলে পুরনো কোড ড্রাইভ লেটার (`C:`) কে "আপেক্ষিক path" ভেবে রিপো রুটের সাথে জোড়া
দিত, ফলে এমন একটা ফোল্ডার বানাতে চাইত যা তৈরি হয় না। **এখন ঠিক করা হয়েছে**, এবং
`backend/tests/test_sqlite_paths.py`-এ ৭টা টেস্ট আছে যাতে আবার না হয়।

> তবে গাইডের সবচেয়ে নিরাপদ পরামর্শ: `DATABASE_URL`-এ **আপেক্ষিক path-ই রাখুন**
> (`sqlite:///./data/symbiotic_city.db`), অথবা `.env` একেবারেই বানাবেন না। ডিফল্ট
> সবসময় ঠিক থাকে।

### উইন্ডোজে আর যা যা মনে রাখবেন

| বিষয় | উইন্ডোজে |
| --- | --- |
| venv python | `.venv\Scripts\python.exe` |
| venv activate | `.venv\Scripts\Activate.ps1` |
| ডেটাবেজ রিসেট | `Remove-Item backend\data\symbiotic_city.db` |
| টেস্ট চালানো | `.venv\Scripts\python.exe -m pytest backend\tests -q` |
| smoke test | `.venv\Scripts\python.exe scripts\smoke.py` |
| পোর্ট busy দেখতে | `Get-NetTCPConnection -LocalPort 3000` |
| সার্ভার বন্ধ করতে | টার্মিনালে `Ctrl + C`, বা `Get-Process node \| Stop-Process` |

> **WSL2 বিকল্প:** যদি PowerShell-এ ঝামেলা মনে হয়, WSL2 (Ubuntu) খুলে উপরের পুরো
> বাংলা গাইডের bash কমান্ডগুলো হুবহু চালাতে পারেন — Linux-এ যাচাই করা পথ সেটাই।
> কোড WSL-এর ভেতরে রাখলে `C:\` ড্রাইভেও রাখতে পারবেন (`/mnt/c/...`), তবে ওখানে
> ফাইল সিস্টেম ধীর, তাই `~/symbiotic-city`-তে রাখাই ভালো।
