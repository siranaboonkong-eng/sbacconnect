import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { motion } from 'framer-motion';
import { showToast } from '../components/ui/Toast';
import sbacLogo from '../assets/sbac_logo_mark.png';
import { homeFor } from '../utils/homeRoute';
import { 
  LogIn, 
  Sun, 
  Moon, 
  Eye, 
  EyeOff, 
  User, 
  Globe,
  ShieldCheck,
  IdCard,
  AlertTriangle,
  Info
} from 'lucide-react';

/* จำเฉพาะ "ชื่อผู้ใช้" เท่านั้น ไม่เก็บรหัสประจำตัวลงเครื่องเด็ดขาด
   เครื่องในห้องคอมเป็นเครื่องใช้ร่วม ถ้าเก็บรหัสไว้ด้วยคนถัดไปล็อกอินเป็นคนก่อนหน้าได้เลย */
const REMEMBER_KEY = 'sbac_remembered_username';

export default function LoginPage() {
  const [userId, setUserId] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [lang, setLang] = useState('TH');
  const passwordRef = useRef(null);
  const { login, authenticating } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  // เติมชื่อผู้ใช้ที่เคยจำไว้ให้อัตโนมัติ (localStorage ถูกบล็อกได้ในโหมดไม่ระบุตัวตน จึงห่อ try)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(REMEMBER_KEY);
      if (saved) setUserId(saved);
      else setRememberMe(false);
    } catch {
      /* ignore */
    }
  }, []);

  const handleLogin = async (e) => {
    e?.preventDefault();
    if (!userId || !nationalId) {
      const errMsg = lang === 'TH' ? 'กรุณากรอกข้อมูลให้ครบถ้วน' : 'Please fill in all fields';
      setError(errMsg);
      showToast(errMsg, 'error');
      return;
    }
    setIsLoading(true);
    setError('');
    const result = await login(userId, nationalId);
    setIsLoading(false);
    if (result.success) {
      try {
        if (rememberMe) localStorage.setItem(REMEMBER_KEY, userId.trim());
        else localStorage.removeItem(REMEMBER_KEY);
      } catch {
        /* ignore */
      }
      const welcomeMsg = lang === 'TH'
        ? `ยินดีต้อนรับคุณ ${result.user.name}`
        : `Welcome, ${result.user.name}`;
      showToast(welcomeMsg, 'success');
      // replace: true — กันไม่ให้กดปุ่ม back แล้วเด้งกลับหน้าล็อกอิน
      // ถ้า navigate พลาดด้วยเหตุผลใดก็ตาม LoginRoute ใน App.jsx จะเด้งให้เองอยู่ดี
      //
      // ต้องส่งทั้ง result.user ไม่ใช่แค่ role เดียว เพราะ homeFor ต้องดู user.roles
      // ทั้งอาร์เรย์เพื่อแยกเจ้าหน้าที่การเงินออกจากคนชงกาแฟ (ทั้งคู่ role = 'barista')
      navigate(homeFor(result.user), { replace: true });
    } else {
      setError(result.error);
      showToast(result.error, 'error');
      /* ไม่ต้องสั่งให้กล่องช่วยเหลือโผล่แล้ว — มันขึ้นถาวรอยู่ใต้ฟอร์มตลอดเวลา
         คนที่ล็อกอินไม่ผ่านจึงเห็นทางเดินต่อไปโดยไม่ต้องกดอะไรเพิ่ม */
    }
  };

  /* ปุ่มรูปดวงตา — สลับ type ของ input อย่างเดียวไม่พอในทางปฏิบัติ

     เบราว์เซอร์กันค่าที่ตัวจัดการรหัสผ่านกรอกให้ (autofill) ไม่ให้ถูกอ่านออกมาง่าย ๆ
     Chrome จะยังวาดเป็นจุดไข่ปลาต่อไปแม้ type จะกลายเป็น text แล้ว
     จนกว่าช่องนั้นจะถูก "ผู้ใช้แตะ" อีกครั้ง ซึ่งพอดีกับอาการที่รายงานเข้ามาเป๊ะ ๆ
     คือกดดวงตาแล้วรหัสไม่โผล่ ทั้งที่สถานะในหน้าเว็บสลับไปแล้วจริง

     สองอย่างที่ทำเพิ่ม:
       preventDefault ตอน mousedown  - โฟกัสไม่หลุดออกจากช่องไปอยู่ที่ปุ่ม
       focus + setSelectionRange     - นับเป็นการแตะช่องอีกครั้ง เบราว์เซอร์จึงยอมวาดตัวอักษรจริง
     ทั้งคู่ไม่มีผลข้างเคียงกับเคสที่พิมพ์เอง (ซึ่งเดิมก็ทำงานถูกอยู่แล้ว) */
  const togglePassword = () => {
    const next = !showPassword;
    setShowPassword(next);

    // รอให้ React เปลี่ยน type ให้เสร็จก่อน ไม่งั้นไปตั้ง caret บนช่องที่ยังเป็น password อยู่
    requestAnimationFrame(() => {
      const el = passwordRef.current;
      if (!el) return;
      el.focus();
      // ช่อง type="password" ห้ามเรียก setSelectionRange ในบางเบราว์เซอร์ — จึงทำเฉพาะตอนเปิดดู
      if (next) {
        try {
          el.setSelectionRange(el.value.length, el.value.length);
        } catch {
          /* ไม่รองรับก็ไม่เป็นไร แค่ caret ไม่ไปอยู่ท้ายบรรทัด */
        }
      }
    });
  };

  const toggleLanguage = () => {
    const nextLang = lang === 'TH' ? 'EN' : 'TH';
    setLang(nextLang);
    showToast(nextLang === 'TH' ? 'เปลี่ยนภาษาเป็น ไทย' : 'Language changed to English', 'info');
  };

  const isDark = theme === 'dark';

  // Translations
  const t = {
    title: 'SBAC CONNECT',
    subtitle: 'Smart Campus • Access • Care',
    formTitle: lang === 'TH' ? 'เข้าสู่ระบบ' : 'Sign In',
    formDesc: lang === 'TH' ? 'กรอกชื่อผู้ใช้และรหัสประจำตัวนักเรียน' : 'Sign in with your username and student code',
    labelUser: lang === 'TH' ? 'ชื่อผู้ใช้ (Username)' : 'Username',
    phUser: lang === 'TH' ? 'กรอกชื่อผู้ใช้' : 'Enter your username',
    labelPass: lang === 'TH' ? 'รหัสประจำตัวนักเรียน' : 'Student Code',
    phPass: lang === 'TH' ? 'กรอกรหัสประจำตัว' : 'Enter your student code',
    remember: lang === 'TH' ? 'จดจำบัญชีผู้ใช้' : 'Remember me',
    btnSubmit: lang === 'TH' ? 'เข้าสู่ระบบ' : 'Sign In',
    btnLoading: lang === 'TH' ? 'กำลังตรวจสอบ...' : 'Authenticating...',
    secTitle: lang === 'TH' ? 'ระบบเชื่อมต่อปลอดภัย' : 'Secured Connection',
    secDesc: lang === 'TH' ? 'ข้อมูลถูกเข้ารหัสเพื่อความปลอดภัย' : 'Your data is encrypted for security',
    helpTitle: lang === 'TH' ? 'เข้าสู่ระบบไม่ได้ใช่ไหม' : 'Trouble signing in?',
    /* ระบบไม่มีฟังก์ชัน "ลืมรหัสผ่าน" อีกต่อไป — ไม่มีปุ่ม ไม่มีลิงก์ ไม่มีการตั้งรหัสใหม่เอง
       เพราะรหัสผ่านอ้างอิงจากเลขบัตรประจำตัวประชาชน/รหัสประจำตัวนักเรียนโดยตรง
       จึงไม่ใช่ความลับที่ "ลืมแล้วต้องรีเซ็ต" แต่เป็นเลขที่เจ้าตัวหาได้จากบัตรของตัวเอง

       บอกก่อนว่ารหัสผ่านคืออะไร แล้วค่อยบอกว่าถ้ายังไม่ได้ต้องไปหาใคร
       เคสส่วนใหญ่จบที่บรรทัดแรกโดยไม่ต้องเดินไปไหน

       ข้อความเดียวใช้กับทุกบทบาท — หน้านี้ใช้ร่วมกันทั้งนักเรียน ครู ฝ่ายวิชาการ
       และร้านค้า และ ณ จังหวะที่อ่านข้อความนี้ยังไม่มีทางรู้ว่าคนอ่านเป็นใคร
       (ยังไม่ได้ล็อกอิน หรือล็อกอินไม่ผ่าน) จึงไม่มี role ให้เลือกข้อความอยู่ดี

       ห้ามใส่อาคาร ชั้น เวลาทำการ หรือเบอร์ติดต่อลงในข้อความนี้ถ้ายังไม่ได้ยืนยัน
       กับฝ่ายวิชาการ — ข้อความบนหน้าล็อกอินคือสิ่งที่คนเชื่อแล้วเดินไปตามนั้นจริง
       ของเดิมเคยระบุ "ฝ่ายทะเบียน อาคาร 1 ชั้น 1" ไว้ ซึ่งเป็นคนละแผนกกับที่ใช้ตอนนี้ */
    helpPass: lang === 'TH'
      ? 'รหัสผ่านของคุณคือเลขบัตรประจำตัวประชาชนหรือรหัสประจำตัวนักเรียน ระบบไม่เปิดให้ตั้งรหัสใหม่เอง'
      : 'Your password is your national ID or student code. The system does not offer self-service password resets.',
    helpBody: lang === 'TH'
      ? 'หากยังเข้าสู่ระบบไม่ได้ กรุณาติดต่อฝ่ายวิชาการโดยตรง'
      : 'If you still cannot sign in, please contact the Academic Affairs Office directly.',
  };

  return (
    /* ระยะห่างของทั้งหน้าคุมด้วย gap-6 ค่าเดียว
       ของเดิมแต่ละก้อนถือ margin ของตัวเอง (mb-8 / mt-6 / mt-8) ช่องไฟจึงเป็น 32-24-32
       ไม่เท่ากันสักช่วง และเวลาเพิ่มก้อนใหม่ก็ต้องเดาว่าควรใส่เท่าไหร่ถึงจะเข้าพวก */
    <div className={`min-h-screen relative flex flex-col items-center justify-center gap-6 px-4 py-10 transition-colors duration-300 ${
      isDark ? 'bg-black text-white' : 'bg-slate-50 text-slate-900'
    }`}>

      {/* Top Controls Bar — top/right ตรงกับ px-4 ของหน้า ไม่ใช่ 20px ที่เยื้องออกมา 4px */}
      <div className="absolute top-4 right-4 z-20 flex items-center gap-3">
        {/* Language Toggler */}
        <button
          onClick={toggleLanguage}
          className={`flex items-center gap-1.5 px-3 min-h-[44px] rounded-xl text-xs font-bold transition-all duration-300 ${
            isDark 
              ? 'bg-neutral-900 hover:bg-neutral-800 text-slate-200 border border-neutral-800' 
              : 'bg-surface-card hover:bg-slate-50 text-slate-700 border border-slate-200/80 shadow-sm'
          }`}
          aria-label="Toggle language"
        >
          <Globe size={14} className="text-brand" />
          <span>{lang}</span>
        </button>

        {/* Theme Toggle Button */}
        <button
          onClick={toggleTheme}
          className={`w-11 h-11 flex items-center justify-center rounded-xl transition-all duration-300 border ${
            isDark 
              ? 'bg-neutral-900 hover:bg-neutral-800 text-accent-amber border-neutral-800' 
              : 'bg-surface-card hover:bg-slate-50 text-sbac-navy border-slate-200/80 shadow-sm'
          }`}
          aria-label="Toggle theme"
          id="login-theme-toggle"
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>

      {/* Logo and Brand Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="text-center relative z-10"
      >
        <div className="relative inline-block mb-4 group">
          <div className="w-28 h-28 inline-flex items-center justify-center p-1 relative z-10">
            <img 
              src={sbacLogo} 
              alt="SBAC Logo" 
              className="w-full h-full object-contain filter drop-shadow-md select-none transform group-hover:scale-105 transition-transform duration-300" 
            />
          </div>
        </div>
        <h1 className={`text-2xl font-extrabold tracking-wider transition-colors duration-300 font-display ${
          isDark ? 'text-white' : 'text-sbac-navy'
        }`}>
          {t.title}
        </h1>
        <div className="flex items-center justify-center gap-2 mt-1.5">
          <p className={`text-[11px] font-bold transition-colors duration-300 ${
            isDark ? 'text-content-secondary' : 'text-content-muted'
          }`}>
            {t.subtitle}
          </p>
        </div>
      </motion.div>

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.1 }}
        className="w-full max-w-md relative z-10"
      >
        <div className={`rounded-3xl p-6 sm:p-8 space-y-6 transition-all duration-300 border ${
          isDark 
            ? 'bg-neutral-900 border-neutral-800 shadow-2xl text-white' 
            : 'bg-surface-card shadow-xl border-slate-200 text-slate-900'
        }`}>
          <div>
            <h2 className={`text-xl font-bold flex items-center gap-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-sbac-navy'
            }`}>
              <LogIn size={22} className="text-brand" />
              <span>{t.formTitle}</span>
            </h2>
            <p className={`text-xs mt-1.5 transition-colors duration-300 ${
              isDark ? 'text-content-secondary' : 'text-content-muted'
            }`}>
              {t.formDesc}
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            {/* User ID field */}
            <div className="space-y-2">
              <label htmlFor="login-user-id" className={`text-[12px] font-bold block transition-colors duration-300 ${
                isDark ? 'text-slate-200' : 'text-slate-600'
              }`}>
                {t.labelUser}
              </label>
              <div className="relative">
                <div className={`absolute left-4 top-1/2 -translate-y-1/2 transition-colors duration-300 ${
                  isDark ? 'text-content-muted' : 'text-content-muted'
                }`}>
                  <User size={18} />
                </div>
                <input
                  type="text"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  placeholder={t.phUser}
                  className={`w-full rounded-2xl pl-12 pr-4 py-3.5 font-medium text-sm transition-all duration-250 focus:outline-none focus:ring-2 border ${
                    isDark 
                      ? 'bg-black border-neutral-800 text-white placeholder:text-content-muted focus:ring-sbac-blue/40 focus:border-sbac-blue'
                      : 'bg-slate-50 border-slate-200 text-slate-800 placeholder:text-content-muted focus:ring-sbac-blue/20 focus:border-sbac-blue focus:bg-surface-card shadow-inner'
                  }`}
                  id="login-user-id"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </div>
            </div>

            {/* National ID / Password field */}
            <div className="space-y-2">
              <label htmlFor="login-national-id" className={`text-[12px] font-bold block transition-colors duration-300 ${
                isDark ? 'text-slate-200' : 'text-slate-600'
              }`}>
                {t.labelPass}
              </label>
              <div className="relative">
                <div className={`absolute left-4 top-1/2 -translate-y-1/2 transition-colors duration-300 ${
                  isDark ? 'text-content-muted' : 'text-content-muted'
                }`}>
                  <IdCard size={18} />
                </div>
                {/* ห้ามใส่ inputMode="numeric" ตรงนี้ — รหัสประจำตัวนักเรียนขึ้นต้นด้วยตัวอักษร
                    (เช่น S0001 ดู 06_seed_real.example.sql) บนมือถือแป้นตัวเลขล้วนพิมพ์ S ไม่ได้เลย */}
                <input
                  ref={passwordRef}
                  type={showPassword ? 'text' : 'password'}
                  value={nationalId}
                  onChange={(e) => setNationalId(e.target.value)}
                  placeholder={t.phPass}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className={`w-full rounded-2xl pl-12 pr-12 py-3.5 font-medium text-sm transition-all duration-250 focus:outline-none focus:ring-2 border ${
                    isDark 
                      ? 'bg-black border-neutral-800 text-white placeholder:text-content-muted focus:ring-sbac-blue/40 focus:border-sbac-blue'
                      : 'bg-slate-50 border-slate-200 text-slate-800 placeholder:text-content-muted focus:ring-sbac-blue/20 focus:border-sbac-blue focus:bg-surface-card shadow-inner'
                  }`}
                  id="login-national-id"
                  autoComplete="current-password"
                />
                {/* ไอคอนบอก "สถานะตอนนี้" ไม่ใช่ "สิ่งที่จะเกิดถ้ากด"
                    ตาเปิด = ตอนนี้อ่านรหัสได้ / ตาขีดฆ่า = ตอนนี้ถูกซ่อนอยู่
                    ของเดิมสลับกัน (ซ่อนอยู่แต่โชว์ตาเปิด) ซึ่งอ่านแล้วขัดกับสิ่งที่เห็นในช่อง
                    เพราะตอนนั้นในช่องเป็นจุดดำ ๆ แต่ไอคอนบอกว่าตาเปิด
                    ส่วนคำอ่านของ screen reader ยังเป็นคำสั่ง ("แสดง/ซ่อน") เหมือนเดิม
                    และ aria-pressed เป็นตัวบอกสถานะ — ครบทั้งสองทางโดยไม่ขัดกันเอง */}
                <button
                  type="button"
                  onClick={togglePassword}
                  /* กันโฟกัสหลุดจากช่องไปอยู่ที่ปุ่มตอนกด — ดูเหตุผลเต็มที่ togglePassword */
                  onMouseDown={(e) => e.preventDefault()}
                  aria-label={showPassword ? 'ซ่อนรหัสประจำตัว' : 'แสดงรหัสประจำตัว'}
                  aria-pressed={showPassword}
                  title={showPassword ? 'ซ่อนรหัสประจำตัว' : 'แสดงรหัสประจำตัว'}
                  /* z-10: ปุ่มของเราต้องอยู่บนสุดเสมอ ช่องรหัสผ่านมีไอคอนของตัวจัดการ
                     รหัสผ่านในเบราว์เซอร์มาวางทับตำแหน่งเดียวกันนี้ได้ */
                  className={`absolute right-1.5 top-1/2 -translate-y-1/2 z-10 w-11 h-11 flex items-center justify-center rounded-xl transition-colors ${
                    showPassword
                      ? 'text-brand bg-sbac-blue/10'
                      : isDark
                      ? 'text-content-muted hover:text-white hover:bg-white/5'
                      : 'text-content-muted hover:text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {showPassword ? <Eye size={17} aria-hidden="true" /> : <EyeOff size={17} aria-hidden="true" />}
                </button>
              </div>
            </div>

            {/* Options Bar — เหลือแค่ "จดจำบัญชีผู้ใช้" อย่างเดียว
                ปุ่ม "ลืมรหัสผ่าน?" ถูกถอดออกทั้งระบบ วิธีขอความช่วยเหลืออยู่ในกล่องถาวรใต้ฟอร์มแทน
                จึงไม่ต้องใช้ justify-between ที่เคยดันของสองชิ้นไปคนละฝั่ง */}
            <div className="flex items-center px-1">
              <label className="flex items-center gap-2 cursor-pointer select-none group">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className={`w-4 h-4 rounded border-slate-300 text-brand focus:ring-sbac-blue/30 transition-all ${
                    isDark ? 'bg-black border-neutral-800' : ''
                  }`}
                />
                <span className={`text-xs font-bold transition-colors duration-200 group-hover:text-brand ${
                  isDark ? 'text-slate-200' : 'text-slate-600'
                }`}>
                  {t.remember}
                </span>
              </label>
            </div>

            {/* Error Message */}
            {error && (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                role="alert"
                className="text-xs text-accent-rose dark:text-accent-rose font-bold bg-rose-500/10 px-4 py-3 rounded-xl border border-rose-500/20 flex items-center gap-2"
              >
                {/* เดิมใช้อีโมจิ ⚠️ ซึ่งวาดด้วยฟอนต์ของเครื่องผู้ใช้ คนละภาษากับไอคอนอื่นทั้งหน้า
                    และเปลี่ยนสีตามข้อความไม่ได้ */}
                <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
                <span>{error}</span>
              </motion.div>
            )}

            {/* วิธีขอความช่วยเหลือ — ขึ้นถาวร ไม่มีปุ่มเปิด ไม่มีปุ่มปิด
                ของเดิมซ่อนอยู่หลังปุ่ม "ลืมรหัสผ่าน?" ที่ต้องรู้ก่อนว่าต้องกด
                ตอนนี้เป็นข้อมูลนิ่ง ๆ ที่อ่านได้ตลอดโดยไม่ต้องล็อกอินไม่ผ่านก่อน */}
            <div
              id="login-help"
              className={`text-xs rounded-xl px-4 py-3 border flex items-start gap-2.5 ${
                isDark
                  ? 'bg-sbac-blue/10 border-sbac-blue/25 text-slate-200'
                  : 'bg-sbac-blue-50 border-sbac-blue/20 text-ink-secondary'
              }`}
            >
              <Info size={16} className="text-brand shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1.5 min-w-0">
                <p className="font-extrabold text-brand">{t.helpTitle}</p>
                <p className="font-semibold leading-relaxed">{t.helpPass}</p>
                <p className="font-semibold leading-relaxed">{t.helpBody}</p>
              </div>
            </div>

            {/* Submit Button with shadow */}
            <motion.button
              type="submit"
              disabled={isLoading || authenticating}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full flex items-center justify-center gap-2 text-white font-extrabold rounded-2xl py-3.5 transition-all duration-200 bg-sbac-blue hover:bg-sbac-navy shadow-lg shadow-sbac-blue/30 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              id="login-submit-btn"
            >
              {(isLoading || authenticating) ? (
                <div className="flex items-center gap-2">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                    className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full"
                  />
                  <span>{t.btnLoading}</span>
                </div>
              ) : (
                <>
                  <span>{t.btnSubmit}</span>
                  <LogIn size={18} />
                </>
              )}
            </motion.button>
          </form>
        </div>
      </motion.div>

      {/* Security Notice */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className={`flex items-center gap-2 max-w-sm px-4 py-2 rounded-full border text-[11px] font-semibold ${
          isDark 
            ? 'bg-neutral-900/60 border-white/10 text-content-secondary' 
            : 'bg-slate-100/50 border-slate-200 text-content-muted'
        }`}
      >
        <ShieldCheck size={14} className="text-accent-emerald" />
        <span className="leading-none">{t.secTitle}</span>
        <span className="opacity-40">|</span>
        <span className="leading-none opacity-80">{t.secDesc}</span>
      </motion.div>

      {/* Footer Info */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className={`text-[11px] font-bold text-center space-y-1.5 relative z-10 transition-colors duration-300 ${
          isDark ? 'text-content-secondary' : 'text-content-muted'
        }`}
      >
        {/* เดิมบรรทัดนี้เป็นข้อความเดียวกับ toast ของปุ่ม "ลืมรหัสผ่าน?" แบบคำต่อคำ
            บวกกับคำว่า "ลืมรหัสผ่าน?" ซ้ำอีกรอบทั้งที่กดไม่ได้ — เหลือแค่ชื่อวิทยาลัยพอ */}
        <div className="opacity-75">วิทยาลัยเทคโนโลยีสยามบริหารธุรกิจ นนทบุรี (SBAC)</div>
        <div className="opacity-60 font-medium">© 2026 Siam Business Administration Technological College. All rights reserved.</div>
      </motion.div>
    </div>
  );
}
