import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../config/supabase';
import { toEmail, toClassId } from '../utils/identity';

const AuthContext = createContext(null);

/* ระบบยืนยันตัวตนใช้ Supabase Auth (แทน Firebase เดิม)
   - นักเรียนกรอก "ชื่อผู้ใช้ + รหัสประจำตัว" → แปลงเป็น email + password ให้อัตโนมัติ
   - session เก็บโดย Supabase เอง (localStorage + refresh token) ไม่ใช่ค่าที่เราปั้นเอง
     จึงแก้ role ผ่าน devtools ไม่ได้เหมือนของเดิม
   - สิทธิ์การอ่านข้อมูลถูกกันด้วย RLS ฝั่ง DB (03_rls.sql) ไม่ใช่การเช็คในหน้าเว็บ */

/** โหลดโปรไฟล์ของผู้ใช้ที่ล็อกอินอยู่
 *
 *  ต้องใส่ where เองทุกคำสั่ง ห้ามพึ่ง RLS เป็นตัวกรอง — policy ใน 03_rls.sql
 *  หลายข้อมีเงื่อนไข or ที่ทำให้บาง role เห็นมากกว่าแถวของตัวเอง:
 *    users            -> or app_has_role('sysadmin')  = sysadmin เห็นทุกคน
 *    user_roles       -> or app_has_role('sysadmin')  = sysadmin เห็น role ของทุกคน
 *    student_profiles -> or teacher or academic       = ครู/วิชาการ เห็นนักเรียนทุกคน
 *
 *  ของเดิมไม่ใส่ where เลยเพราะเชื่อว่า RLS กรองให้แล้ว ผลคือ:
 *    - sysadmin: maybeSingle() บน users เจอหลายแถว -> โยน PGRST116 -> ตกไปที่ catch
 *      ของ login() แล้วขึ้นข้อความ "ไม่สามารถเชื่อมต่อระบบได้" ซึ่งชี้ผิดทางสนิท
 *      = บัญชีแอดมินล็อกอินไม่ได้เลยแม้แต่ครั้งเดียว
 *    - ครู/วิชาการ: student_profiles ก็เจอหลายแถวเหมือนกัน แต่บังเอิญรอดมาได้
 *      เพราะอยู่ใน Promise.all ซึ่ง supabase คืน error เป็นค่า ไม่ throw
 *      -> profileRes.data เป็น null เงียบ ๆ (ความบังเอิญ ไม่ใช่การออกแบบ)
 *
 *  ตัวกรองนี้ทำหน้าที่ "เลือกแถวที่ต้องการ" เท่านั้น ไม่ใช่ด่านความปลอดภัย
 *  ด่านจริงยังเป็น RLS ฝั่ง DB เหมือนเดิม แก้ค่าใน devtools แล้วไม่ได้อะไรเพิ่ม */
async function loadProfile() {
  // getSession() อ่านจากเครื่อง ไม่ยิงเน็ต — เร็วกว่า getUser() และพอสำหรับใช้เป็นตัวกรอง
  const { data: sessionData } = await supabase.auth.getSession();
  const authUid = sessionData?.session?.user?.id;
  if (!authUid) return null;

  const { data: userRow, error: userErr } = await supabase
    .from('users')
    .select('id, email, full_name')
    .eq('auth_uid', authUid)
    .maybeSingle();

  if (userErr) throw userErr;
  if (!userRow) return null; // ล็อกอินผ่าน แต่ไม่มีแถวใน users = ยังไม่ถูกลงทะเบียน

  // ดึงข้อมูลส่วนที่เหลือแบบขนาน ลดเวลารอ
  const [roleRes, profileRes, teacherRes, balanceRes] = await Promise.all([
    supabase.from('user_roles').select('role').eq('user_id', userRow.id),
    supabase
      .from('student_profiles')
      .select('student_code, class_rooms(level, room_no)')
      .eq('user_id', userRow.id)
      .maybeSingle(),
    /* แถวของตัวเองเท่านั้น — policy teacher_self_select ยอมให้อ่านได้อยู่แล้ว
       นักเรียนยิงมาก็ได้ null กลับไปเฉย ๆ ไม่ต้องแยกเงื่อนไขตาม role ให้ยุ่ง
       (ต้องรู้ role ก่อนถึงจะรู้ว่าควรยิงไหม แต่ role ก็มาจากคำสั่งในชุดนี้เอง) */
    supabase
      .from('teacher_profiles')
      .select('teacher_code, department')
      .eq('user_id', userRow.id)
      .maybeSingle(),
    supabase.rpc('my_balance'),
  ]);

  const roles = (roleRes.data || []).map((r) => r.role);
  // คนหนึ่งมีได้หลาย role — เลือกอันที่สิทธิ์สูงสุดมาใช้กำหนดหน้าเริ่มต้น
  const dbRole =
    roles.find((r) => r === 'sysadmin') ||
    roles.find((r) => r === 'academic') ||
    roles.find((r) => r === 'teacher') ||
    roles.find((r) => r === 'pos') ||
    roles.find((r) => r === 'cashier') ||
    'student';

  // ฝั่ง DB ใช้ 'pos' (enum app_role ไม่มี 'barista')
  // ส่วนหน้าเว็บใช้ชื่อ 'barista' มาตั้งแต่แรกทั้งใน routing และเมนู
  // แปลงตรงนี้จุดเดียว จะได้ไม่ต้องไล่แก้ App.jsx / BottomNav ทั้งหมด
  const role = dbRole === 'pos' || dbRole === 'cashier' ? 'barista' : dbRole;

  const sp = profileRes.data;
  const tp = teacherRes.data;
  const room = sp?.class_rooms || null;
  const balanceSatang = Number(balanceRes.data ?? 0);

  return {
    // ใช้รหัสนักเรียนเป็น id ที่แสดงผล (ของเดิมก็ใช้รหัสนักเรียน)
    id: sp?.student_code || userRow.email.split('@')[0],
    uid: userRow.id, // uuid จริงใน DB เผื่อต้องอ้างอิง
    name: userRow.full_name,
    email: userRow.email,
    role,
    roles,
    class_id: room ? toClassId(room.level, room.room_no) : '',
    room: room?.room_no || '',
    year: room ? String(room.level).match(/\d+/)?.[0] || '' : '',
    /* ป้ายห้องที่เอาไปแสดงได้ตรง ๆ เช่น 'ปวช.3/6'
       ต่างจาก class_id ('m3_6') ที่เป็นคีย์ของตารางสอนใน sheets.js ไม่ใช่ของที่เอาให้คนอ่าน
       หน้าแรกเคยไม่มีอะไรบอกห้องเลย มีแต่ ID กับสาขาที่ hardcode ไว้ */
    class_label: room ? `${room.level}/${room.room_no}` : '',
    // ฝั่งอาจารย์ — เดิมหน้าครูเขียนแผนกกับห้องที่ดูแลไว้ตายตัวในโค้ด
    // ครูทุกคนจึงขึ้นข้อความเดียวกันหมดไม่ว่าจะสอนแผนกไหน
    teacher_code: tp?.teacher_code || '',
    department: tp?.department || '',
    session: '',
    // เก็บทั้งสองหน่วย: satang ไว้คำนวณ (แม่นยำ), baht ไว้แสดงผลให้เข้ากับ UI เดิม
    balance_satang: balanceSatang,
    card_balance: balanceSatang / 100,
  };
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authenticating, setAuthenticating] = useState(false);

  const refreshProfile = useCallback(async () => {
    try {
      const profile = await loadProfile();
      setUser(profile);
      return profile;
    } catch (err) {
      console.error('[auth] โหลดโปรไฟล์ล้มเหลว:', err);
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    let active = true;

    /* ตรวจ session ที่ค้างอยู่ตอนเปิดแอป
       ต้องมี catch และต้องปิด loading ใน finally เสมอ

       ของเดิม setLoading(false) อยู่ใน .then อย่างเดียว ไม่มี .catch เลย
       ถ้า getSession() reject (เน็ตหลุด เซิร์ฟเวอร์ล่ม DNS พัง ซึ่งเกิดได้จริง
       บนไวไฟโรงเรียน) loading จะค้างเป็น true ตลอดกาล
       ผู้ใช้เห็นหน้า "กำลังโหลด..." หมุนไม่จบ ไม่มีข้อความ ไม่มีทางออก
       ต้องปิดแอปเปิดใหม่อย่างเดียว และเปิดใหม่ก็เจอเหมือนเดิมถ้าเน็ตยังไม่มา

       ตอนนี้ล้มแล้วตกไปหน้า login ซึ่งกดลองใหม่ได้ ดีกว่าค้างแบบไม่บอกอะไร */
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!active) return;
        if (data?.session) await refreshProfile();
      })
      .catch((err) => {
        console.error('[auth] อ่าน session ตอนเปิดแอปไม่สำเร็จ:', err);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    // ติดตามการเปลี่ยนสถานะ (ล็อกอิน/ออก/ต่ออายุ token) จากทุกแท็บ
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!active) return;
      if (event === 'SIGNED_OUT' || !session) {
        setUser(null);
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        await refreshProfile();
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [refreshProfile]);

  /** login(ชื่อผู้ใช้, รหัสประจำตัว)
   *  คงลายเซ็นเดิมไว้ เพื่อให้ LoginPage.jsx ใช้ต่อได้โดยไม่ต้องแก้ตรรกะ */
  const login = async (username, studentCode) => {
    if (!isSupabaseConfigured) {
      return { success: false, error: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase (ดู .env.example)' };
    }

    setAuthenticating(true);
    try {
      const email = toEmail(username);

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: String(studentCode).trim(),
      });

      if (signInError) {
        // ไม่แยกข้อความว่า "ไม่มีชื่อผู้ใช้นี้" กับ "รหัสผิด"
        // เพราะจะกลายเป็นเครื่องมือให้คนไล่เดาว่าใครมีบัญชีอยู่ในระบบบ้าง
        return { success: false, error: 'ชื่อผู้ใช้หรือรหัสประจำตัวไม่ถูกต้อง' };
      }

      const profile = await loadProfile();

      if (!profile) {
        // ล็อกอินผ่าน Auth แต่ไม่มีแถวใน public.users
        // (auth_uid ยังไม่ถูกผูก หรือแอดมินยังไม่ได้ลงทะเบียนคนนี้)
        await supabase.auth.signOut();
        /* ชี้ไปฝ่ายวิชาการให้ตรงกับหน้าล็อกอินและแชทบอท — คนเข้าระบบไม่ได้ต้องมีปลายทางเดียว
           ของเดิมบอกให้ไปฝ่ายทะเบียน ซึ่งกลายเป็นช่องทางที่สองหลังถอดเมนูลืมรหัสผ่านออก */
        return {
          success: false,
          error: 'บัญชีนี้ยังไม่ถูกลงทะเบียน กรุณาติดต่อฝ่ายวิชาการ',
        };
      }

      setUser(profile);
      return { success: true, user: profile };
    } catch (err) {
      console.error('[auth] login ล้มเหลว:', err);
      return { success: false, error: 'ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่อีกครั้ง' };
    } finally {
      setAuthenticating(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  /** ยอดเงินเปลี่ยนได้จากฝั่ง DB เท่านั้น (place_order / topup_cash)
   *  หน้าเว็บทำได้แค่ "ดึงยอดล่าสุด" มาแสดง — เขียน wallet_entries ตรงถูก revoke ไว้แล้ว */
  const updateBalance = async () => {
    const { data, error } = await supabase.rpc('my_balance');
    if (error) {
      console.error('[auth] อ่านยอดเงินล้มเหลว:', error);
      return;
    }
    const satang = Number(data ?? 0);
    setUser((prev) =>
      prev ? { ...prev, balance_satang: satang, card_balance: satang / 100 } : prev
    );
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, authenticating, login, logout, updateBalance, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

export default AuthContext;
