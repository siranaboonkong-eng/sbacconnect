/* ตรรกะของผู้ช่วย SBAC Connect — แยกจาก UI เพื่อให้ทดสอบและแก้คำตอบได้โดยไม่ต้องแตะ JSX
   สิ่งที่ต่างจากแชทบอทตัวเดิมโดยตั้งใจ:

   1) ไม่ท่องข้อมูลตายตัวที่หมดอายุได้
      ตัวเดิมฝัง "ปฏิทินกิจกรรม ก.ค. 2569", รายชื่อ 12 สาขา, เลขห้อง 1101-1512
      และเบอร์โทรต่อไว้ในโค้ด พอฝ่ายวิชาการย้ายปฏิทินมาอยู่ใน DB (10_events.sql)
      บอทก็ยังตอบปฏิทินเดือนเดิมต่อไป = ตอบผิดโดยที่ไม่มีใครรู้
      ตัวนี้ตอบจากข้อมูลที่ดึงสดทุกครั้ง (context) ถ้าดึงไม่ได้ก็บอกตรง ๆ ว่าดึงไม่ได้

   2) ไม่ปลอมผลลัพธ์
      ตัวเดิมสร้างเลขใบแจ้งซ่อมจาก Date.now() แล้วตอบว่า "ฝ่ายอาคารจะดำเนินการภายใน
      24-48 ชม." ทั้งที่ไม่ได้บันทึกที่ไหนเลย ตัวนี้เลขใบมาจาก DB (23_repair_tickets.sql)
      และจะตอบว่าสำเร็จก็ต่อเมื่อ RPC ตอบ ok กลับมาแล้วเท่านั้น

   3) พาไปหน้าที่ทำงานจริง แทนที่จะอธิบายว่าปุ่มอยู่ตรงไหน
*/

import { supabase } from '../config/supabase';
import { formatBaht } from './identity';
import { categoryLabel } from './orders';
import {
  DAY_LABELS,
  PERIOD_TIMES,
  applySubstitutions,
  classLabel,
  describeDate,
  fetchBaseTimetable,
  fetchSubstitutions,
  isSchoolDay,
  timetableTitle,
  todayISO,
  weekdayKeyOf,
} from './timetable';

/** ปุ่มลัดใต้ช่องพิมพ์ — ต่างกันตาม role เพราะเมนูของแต่ละ role ไม่เหมือนกัน
 *
 *  ป้ายต้องสั้น: กล่องแชทกว้างราว 360px ป้ายยาวอย่าง 'ใบแจ้งซ่อมของฉัน' หรือ
 *  'คะแนนความประพฤติ' ทำให้ปุ่มล้นออกนอกจอ ต้องเลื่อนซ้ายขวาถึงจะเห็นครบ
 *  ซึ่งไม่มีอะไรบอกด้วยว่ายังมีต่อ คนใช้จึงไม่รู้ว่ามีปุ่มที่เหลืออยู่
 *  ตอนนี้ปุ่มขึ้นบรรทัดใหม่แทนการเลื่อน (ดู AssistantFAB) ป้ายจึงต้องสั้นพอ
 *  ให้สองบรรทัดจบ ไม่ใช่สี่บรรทัดจนดันช่องพิมพ์ตกจอ */
export function quickActionsFor(role) {
  const repair = { label: 'แจ้งซ่อมอุปกรณ์', intent: 'repair' };
  const myRepairs = { label: 'ใบซ่อมของฉัน', intent: 'repair_status' };
  const menu = { label: 'เมนูวันนี้', intent: 'menu' };

  if (role === 'academic') {
    return [
      { label: 'คิวแจ้งซ่อม', intent: 'repair_status' },
      { label: 'ใบลารออนุมัติ', intent: 'leave' },
      { label: 'กิจกรรมที่จะถึง', intent: 'events' },
      repair,
    ];
  }

  if (role === 'teacher') {
    return [
      { label: 'ใบลารออนุมัติ', intent: 'leave' },
      { label: 'กิจกรรมที่จะถึง', intent: 'events' },
      menu,
      repair,
      myRepairs,
    ];
  }

  if (role === 'barista') {
    return [repair, myRepairs, { label: 'ถามอะไรได้บ้าง', intent: 'help' }];
  }

  return [
    { label: 'ยอดเงินในบัตร', intent: 'balance' },
    { label: 'ตารางวันนี้', intent: 'timetable' },
    { label: 'เมนูวันนี้', intent: 'menu' },
    { label: 'คะแนนพฤติกรรม', intent: 'behavior' },
    { label: 'เวลาเข้าเรียน', intent: 'gate' },
    { label: 'กิจกรรมที่จะถึง', intent: 'events' },
    { label: 'สถานะใบลา', intent: 'leave' },
    repair,
    myRepairs,
  ];
}

/* คำที่ใช้จับความตั้งใจ เรียงจากเฉพาะเจาะจงไปกว้าง — ตัวแรกที่แมตช์ชนะ
   ลำดับสำคัญ: 'สถานะแจ้งซ่อม' ต้องมาก่อน 'แจ้งซ่อม' ไม่งั้นคนถามสถานะจะโดนพาไปเปิดใบใหม่ */
const INTENTS = [
  { id: 'repair_status', keywords: ['สถานะแจ้งซ่อม', 'ใบแจ้งซ่อม', 'แจ้งซ่อมของฉัน', 'ตามเรื่องซ่อม', 'ซ่อมถึงไหน', 'เลขที่แจ้ง'] },
  { id: 'repair', keywords: ['แจ้งซ่อม', 'ซ่อม', 'แอร์', 'พัดลม', 'โปรเจคเตอร์', 'projector', 'หลอดไฟ', 'ไฟดับ', 'ไฟไม่ติด', 'น้ำรั่ว', 'ประปา', 'ชักโครก', 'เน็ตไม่ติด', 'wifi', 'ไวไฟ', 'เครื่องเสียง', 'ลำโพง', 'พัง', 'เสีย', 'ไม่เย็น'] },
  /* 'menu' ต้องมาก่อน 'orders' เพราะคนถามว่า "มีกาแฟอะไรบ้าง" อยากได้รายการเมนู
     ไม่ใช่สถานะออเดอร์ของตัวเอง — ทั้งสองอันมีคำว่า "กาแฟ" เหมือนกัน */
  { id: 'menu', keywords: ['เมนู', 'มีอะไรขาย', 'ขายอะไร', 'ราคากาแฟ', 'ราคาเครื่องดื่ม', 'กี่บาท', 'ราคา', 'menu'] },
  { id: 'balance', keywords: ['ยอดเงิน', 'เงินเหลือ', 'คงเหลือ', 'เติมเงิน', 'wallet', 'กระเป๋าเงิน', 'เงินในบัตร', 'balance'] },
  { id: 'wallet_history', keywords: ['รายการเงิน', 'ประวัติเงิน', 'เงินหายไปไหน', 'ใช้เงินไปเท่าไร', 'เงินเข้าออก', 'ประวัติการใช้จ่าย'] },
  { id: 'gate', keywords: ['เข้าโรงเรียน', 'เวลาเข้า', 'สแกนเข้า', 'ประตู', 'มาสาย', 'เข้าเรียนกี่โมง', 'ตอกบัตร'] },
  { id: 'behavior', keywords: ['ความประพฤติ', 'คะแนนพฤติกรรม', 'ตัดคะแนน', 'พฤติกรรม', 'โดนหัก'] },
  { id: 'events', keywords: ['กิจกรรม', 'ปฏิทิน', 'อีเวนต์', 'event', 'events', 'วันหยุด', 'สอบ', 'รด.', 'กำหนดส่ง'] },
  { id: 'leave', keywords: ['ใบลา', 'ลาป่วย', 'ลากิจ', 'ขอลา', 'ยื่นลา', 'ลาเรียน', 'อนุมัติลา'] },
  { id: 'orders', keywords: ['ออเดอร์', 'คำสั่งซื้อ', 'รหัสรับของ', 'กาแฟ', 'เครื่องดื่ม', 'สั่งน้ำ', 'คิว', 'order', 'orders']  },
  { id: 'timetable', keywords: ['ตารางเรียน', 'ตารางสอน', 'ตาราง', 'คาบ', 'เรียนอะไร', 'สอนอะไร', 'วิชาอะไร'] },
  { id: 'password', keywords: ['ลืมรหัส', 'เปลี่ยนรหัส', 'รหัสผ่าน', 'password', 'reset', 'เข้าระบบไม่ได้', 'ล็อกอินไม่ได้'] },
  { id: 'greeting', keywords: ['สวัสดี', 'หวัดดี', 'hello', 'hi', 'ดีครับ', 'ดีค่ะ'] },
  { id: 'thanks', keywords: ['ขอบคุณ', 'ขอบใจ', 'thank', 'thanks'] },
  { id: 'help', keywords: ['ช่วยอะไรได้', 'ทำอะไรได้', 'help', 'คำสั่ง', 'ใช้ยังไง'] },
];

/* ภาษาไทยไม่เว้นวรรคระหว่างคำ จะเทียบแบบ "มีคำนี้อยู่ในประโยคไหม" (includes) ได้เลย
   แต่คำอังกฤษเทียบแบบนั้นไม่ได้ ตัวอย่างที่พังจริงในตัวเดิม:
     'hi'   ไปแมตช์กับ this / which / history / machine
     'menu' ไปแมตช์กับ menu แต่ก็รวมถึงคำอื่นที่มี menu ต่อท้าย
   คำที่เป็นอักษรละตินล้วนจึงต้องเทียบแบบมีขอบเขตคำ (\b...\b) */
const ASCII_ONLY = /^[a-z0-9.\s-]+$/;

const boundaryCache = new Map();

function matchesKeyword(haystack, keyword) {
  const k = keyword.toLowerCase();
  if (!ASCII_ONLY.test(k)) return haystack.includes(k);

  let re = boundaryCache.get(k);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    boundaryCache.set(k, re);
  }
  return re.test(haystack);
}

/** ข้อความผู้ใช้ -> id ความตั้งใจ (null = ไม่รู้จัก) */
export function matchIntent(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return null;
  for (const intent of INTENTS) {
    if (intent.keywords.some((k) => matchesKeyword(lower, k))) return intent.id;
  }
  return null;
}

/* คำที่แปลว่า "พอแล้ว ออกจากขั้นตอนนี้"

   ทำไมต้องมี: ตอนบอทถามหาเลขห้องหรือรายละเอียดปัญหา ข้อความถัดไปทุกข้อความ
   จะถูกเก็บเป็นคำตอบของคำถามนั้นทั้งหมด ไม่ว่าผู้ใช้จะพิมพ์อะไรมา
   ใครเปลี่ยนใจกลางคันแล้วพิมพ์ "ยกเลิก" หรือ "ขอดูยอดเงินแทน"
   จะได้ห้องชื่อ "ยกเลิก" กลับไปแทน แล้วติดอยู่ในขั้นตอนต่อไปอีก ออกไม่ได้เลย
   นอกจากปิดกล่องแชททิ้ง */
const CANCEL_WORDS = ['ยกเลิก', 'ไม่เอาแล้ว', 'ไม่เอา', 'พอแล้ว', 'หยุด', 'ออก', 'เลิก', 'cancel', 'stop'];

export function isCancelWord(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower || lower.length > 20) return false;
  return CANCEL_WORDS.some((w) => matchesKeyword(lower, w));
}

/* คำที่บอกว่าน่าจะเป็นอุปกรณ์อะไร ใช้เดาให้ผู้ใช้ไม่ต้องพิมพ์ซ้ำ
   เดาผิดไม่เสียหาย เพราะสรุปให้ยืนยันก่อนส่งเสมอ และผู้ใช้แก้ได้ */
const EQUIPMENT_HINTS = [
  [['แอร์', 'เครื่องปรับอากาศ', 'ไม่เย็น'], 'เครื่องปรับอากาศ'],
  [['พัดลม'], 'พัดลม'],
  [['โปรเจคเตอร์', 'projector', 'โปรเจ็คเตอร์'], 'โปรเจคเตอร์'],
  [['หลอดไฟ', 'ไฟดับ', 'ไฟไม่ติด', 'ไฟ'], 'ระบบไฟฟ้า / หลอดไฟ'],
  [['คอม', 'computer', 'พีซี', 'จอ'], 'คอมพิวเตอร์'],
  [['ลำโพง', 'เครื่องเสียง', 'ไมค์'], 'ระบบเสียง'],
  [['wifi', 'ไวไฟ', 'เน็ต', 'อินเทอร์เน็ต', 'อินเตอร์เน็ต'], 'ระบบเครือข่าย / WiFi'],
  [['ประปา', 'น้ำรั่ว', 'ก๊อก', 'ชักโครก', 'ห้องน้ำ'], 'ระบบประปา / สุขภัณฑ์'],
  [['โต๊ะ', 'เก้าอี้', 'ประตู', 'หน้าต่าง', 'กระจก'], 'ครุภัณฑ์ / อาคาร'],
];

export function detectEquipment(text) {
  const lower = String(text || '').toLowerCase();
  for (const [keys, label] of EQUIPMENT_HINTS) {
    if (keys.some((k) => lower.includes(k))) return label;
  }
  return null;
}

/** ดึงเลขห้องจากข้อความ เช่น "แอร์ห้อง 1406 ไม่เย็น" -> "1406"
 *  ยอมรับ 3-4 หลักเท่านั้น กันไม่ให้ไปหยิบปีหรือจำนวนเงินมาเป็นเลขห้อง */
export function extractRoom(text) {
  const match = String(text || '').match(/(?:ห้อง|ที่|room)\s*(\d{3,4})|(\b\d{3,4}\b)/i);
  return match ? match[1] || match[2] : null;
}

const STATUS_LABELS = {
  open: 'รอฝ่ายวิชาการรับเรื่อง',
  in_progress: 'กำลังดำเนินการ',
  done: 'ซ่อมเสร็จแล้ว',
  cancelled: 'ยกเลิกแล้ว',
};

export const repairStatusLabel = (status) => STATUS_LABELS[status] || status;

const LEAVE_STATUS_LABELS = {
  pending_teacher: 'รอครูประจำชั้นอนุมัติ',
  pending_academic: 'รอฝ่ายวิชาการอนุมัติ',
  approved: 'อนุมัติแล้ว',
  rejected_by_teacher: 'ครูประจำชั้นไม่อนุมัติ',
  rejected_by_academic: 'ฝ่ายวิชาการไม่อนุมัติ',
};

export const leaveStatusLabel = (status) => LEAVE_STATUS_LABELS[status] || status;

const bahtText = (n) =>
  Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dayText = (date) => {
  const d = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return 'วันนี้';
  if (diffDays === 1) return 'พรุ่งนี้';
  if (diffDays > 1 && diffDays <= 7) return `อีก ${diffDays} วัน`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/* คำตอบของแต่ละ intent
   รับ context ที่ดึงสดมาจาก DB แล้ว (ไม่มี intent ไหนตอบจากค่าที่ฝังไว้ในไฟล์นี้)
   คืน { text, actions? } — actions คือปุ่มพาไปหน้าที่ทำงานนั้นได้จริง */
export function answerFor(intentId, ctx) {
  const { user, events, eventsLoading, leaveRequests, leaveLoading, activeOrderCount } = ctx;
  const role = user?.role || 'student';
  const isStudent = role === 'student';

  switch (intentId) {
    case 'greeting':
      return {
        text: `สวัสดีครับคุณ ${user?.name || ''}\nพิมพ์ถามได้เลย หรือกดปุ่ม "ถามอะไรได้บ้าง" เพื่อดูรายการที่ผมตอบได้ครับ`,
      };

    case 'thanks':
      return { text: 'ยินดีครับ มีอะไรให้ช่วยอีกพิมพ์บอกได้ตลอดครับ' };

    case 'balance': {
      const baht = bahtText(user?.card_balance);
      return {
        text: `ยอดเงินในบัตรตอนนี้ ${baht} บาท\n(ยอดนี้ดึงสดจากระบบ อัปเดตทุกครั้งที่มีรายการเข้า-ออก)`,
        actions: [
          { label: 'เติมเงิน / ดูรายการ', path: '/home' },
          { label: 'สั่งเครื่องดื่ม', path: '/coffee' },
        ],
      };
    }

    case 'behavior': {
      if (!isStudent) {
        return {
          text: 'คะแนนความประพฤติเป็นข้อมูลรายบุคคลของนักเรียนครับ\nถ้าต้องการดูหรือบันทึกคะแนนของนักเรียน ใช้หน้าจัดการได้เลย',
          actions: [{ label: 'ไปหน้าหลัก', path: role === 'teacher' ? '/teacher' : '/academic' }],
        };
      }
      const score = ctx.behaviorScore;
      if (score === null || score === undefined) {
        return { text: 'ตอนนี้ดึงคะแนนความประพฤติไม่ได้ครับ ลองเปิดหน้าหลักดูอีกครั้ง', actions: [{ label: 'ไปหน้าหลัก', path: '/home' }] };
      }
      const deducted = 100 - score;
      return {
        text:
          `คะแนนความประพฤติของคุณตอนนี้ ${score} / 100 คะแนน` +
          (deducted > 0 ? `\nถูกหักไปแล้วรวม ${deducted} คะแนน` : '\nยังไม่เคยถูกหักคะแนนเลยครับ') +
          '\nดูประวัติการหักคะแนนแต่ละครั้งได้ที่หน้าหลัก',
        actions: [{ label: 'ดูประวัติคะแนน', path: '/home' }],
      };
    }

    case 'events': {
      if (eventsLoading) return { text: 'กำลังดึงปฏิทินกิจกรรมอยู่ครับ สักครู่' };
      if (!events || events.length === 0) {
        return {
          text: 'ตอนนี้ยังไม่มีกิจกรรมที่กำลังจะถึงในปฏิทินครับ\nถ้าฝ่ายวิชาการเพิ่มเข้ามาใหม่จะขึ้นให้เห็นทันที',
        };
      }
      const lines = events
        .slice(0, 5)
        .map((e) => `• ${e.title} — ${dayText(e.start)}${e.location ? ` ที่ ${e.location}` : ''}`);
      return {
        text: `กิจกรรมที่กำลังจะถึง ${events.length} รายการครับ\n${lines.join('\n')}`,
        actions: [{ label: 'ดูปฏิทินเต็ม', path: isStudent ? '/home' : role === 'teacher' ? '/teacher' : '/academic' }],
      };
    }

    case 'leave': {
      if (leaveLoading) return { text: 'กำลังดึงข้อมูลใบลาอยู่ครับ สักครู่' };

      if (isStudent) {
        if (!leaveRequests || leaveRequests.length === 0) {
          return {
            text: 'คุณยังไม่เคยยื่นใบลาในระบบครับ\nยื่นได้จากหน้าหลัก เลือกประเภทการลา วันที่ และเหตุผล\nยื่นแล้วจะผ่านครูประจำชั้นก่อน แล้วจึงถึงฝ่ายวิชาการ',
            actions: [{ label: 'ยื่นใบลา', path: '/home' }],
          };
        }
        const latest = leaveRequests[0];
        const lines = leaveRequests
          .slice(0, 3)
          .map((r) => `• ${r.start_date}${r.end_date && r.end_date !== r.start_date ? ` ถึง ${r.end_date}` : ''} — ${leaveStatusLabel(r.status)}`);
        return {
          text:
            `ใบลาล่าสุดของคุณ: ${leaveStatusLabel(latest.status)}` +
            (latest.rejection_reason ? `\nเหตุผล: ${latest.rejection_reason}` : '') +
            `\n\nรายการล่าสุด\n${lines.join('\n')}`,
          actions: [{ label: 'ดูใบลาทั้งหมด', path: '/home' }],
        };
      }

      const pending = (leaveRequests || []).filter((r) =>
        role === 'teacher' ? r.status === 'pending_teacher' : r.status === 'pending_academic'
      );
      if (pending.length === 0) {
        return { text: 'ตอนนี้ไม่มีใบลาที่รอคุณอนุมัติครับ' };
      }
      const lines = pending
        .slice(0, 5)
        .map((r) => `• ${r.student_name}${r.class_label ? ` (${r.class_label})` : ''} — ${r.start_date}`);
      return {
        text: `มีใบลารอคุณอนุมัติ ${pending.length} ใบครับ\n${lines.join('\n')}`,
        actions: [{ label: 'ไปอนุมัติใบลา', path: role === 'teacher' ? '/teacher' : '/academic' }],
      };
    }

    case 'orders': {
      if (!isStudent && role !== 'teacher') {
        return { text: 'หน้าคิวเครื่องดื่มอยู่ที่หน้าร้านกาแฟครับ', actions: [{ label: 'ไปหน้าร้าน', path: '/barista' }] };
      }
      const n = activeOrderCount;
      const codes = ctx.activePickupCodes || [];
      return {
        text:
          n > 0
            ? `ตอนนี้คุณมีออเดอร์ที่ยังไม่เสร็จอยู่ ${n} รายการครับ` +
              /* รหัสรับของคือสิ่งเดียวที่ต้องยื่นให้บาริสต้าตอนไปรับ
                 ถามบอทแล้วได้แค่จำนวนใบ ยังต้องเปิดอีกหน้าเพื่อดูรหัสอยู่ดี */
              (codes.length > 0 ? `\nรหัสรับของ **${codes.join('**, **')}**` : '')
            : 'ตอนนี้คุณไม่มีออเดอร์ที่ค้างอยู่ครับ',
        actions: [
          { label: 'สั่งเครื่องดื่ม', path: '/coffee' },
          { label: 'ดูออเดอร์ของฉัน', path: '/orders' },
        ],
      };
    }

    /* intent พวกนี้ต้องยิงถามฐานข้อมูลก่อนถึงจะตอบได้
       AssistantFAB จะเรียก fetch*Answer() ให้แทน ไม่ผ่านทางนี้
       ถ้ามาถึงตรงนี้แปลว่ามีคนลืมต่อสาย จึงตอบแบบไม่มั่วข้อมูลไว้ก่อน */
    case 'menu':
    case 'gate':
    case 'wallet_history':
    case 'timetable':
      return {
        text: 'ตอนนี้ดึงข้อมูลส่วนนี้ไม่ได้ครับ ลองใหม่อีกครั้ง',
      };

    case 'password':
      /* คำตอบเดียวกับกล่องถาวรในหน้าล็อกอิน (t.helpPass + t.helpBody ใน LoginPage.jsx)
         ถ้าจะแก้ที่ทางเดินของคนเข้าระบบไม่ได้ ต้องแก้ทั้งสองที่ให้ตรงกันเสมอ

         ระบบไม่มีฟังก์ชัน "ลืมรหัสผ่าน" แล้ว จึงไม่พูดถึงการรีเซ็ตหรือขอรหัสใหม่อีก
         รหัสผ่านคือเลขบัตรประชาชน/รหัสนักเรียนของเจ้าตัว ซึ่งหาได้จากบัตรของตัวเอง
         คำตอบจึงบอกว่ารหัสคืออะไรก่อน แล้วค่อยชี้ไปฝ่ายวิชาการถ้ายังไม่ได้

         ไม่แยกตาม role ทั้งที่ตรงนี้รู้ role อยู่ — ฝ่ายวิชาการเป็นจุดรับเรื่องจุดเดียว
         ของทุกคน และห้ามใส่อาคาร/ชั้น/เบอร์ที่ยังไม่ได้ยืนยันเหมือนหน้าล็อกอิน */
      return {
        text: 'รหัสผ่านของคุณคือเลขบัตรประจำตัวประชาชนหรือรหัสประจำตัวนักเรียนครับ\nระบบไม่เปิดให้ตั้งรหัสใหม่เอง และไม่มีเมนูลืมรหัสผ่าน\n\nถ้ากรอกตามนี้แล้วยังเข้าไม่ได้ กรุณาติดต่อฝ่ายวิชาการโดยตรงครับ',
      };

    case 'help':
    default:
      return {
        text:
          'ผมช่วยเรื่องพวกนี้ได้ครับ\n' +
          (isStudent
            ? '• **ตารางวันนี้** เรียนคาบไหน วิชาอะไร ห้องไหน มีสอนแทนไหม\n' +
              '• **เมนูวันนี้** ร้านมีอะไรขาย ราคาเท่าไร\n' +
              '• **ยอดเงิน** และ **รายการเงินเข้า-ออก** ล่าสุด\n' +
              '• **คะแนนความประพฤติ** และประวัติการหักคะแนน\n' +
              '• **เวลาเข้าโรงเรียน** ที่สแกนบัตรไว้\n' +
              '• **สถานะใบลา** และ **ออเดอร์เครื่องดื่ม** พร้อมรหัสรับของ\n'
            : '• **ใบลาที่รออนุมัติ**\n• **เมนูร้านกาแฟ** และราคา\n') +
          '• **กิจกรรมที่กำลังจะถึง** ในปฏิทินฝ่ายวิชาการ\n' +
          '• **แจ้งซ่อมอุปกรณ์** และตามสถานะใบแจ้งซ่อม\n\n' +
          'พิมพ์ถามเป็นภาษาปกติได้เลย หรือกดปุ่มลัดด้านล่างก็ได้ครับ\n' +
          'ทุกคำตอบดึงจากข้อมูลจริงในระบบ ไม่ใช่ข้อความสำเร็จรูป',
      };
  }
}

/* ============================================================
   คำตอบที่ต้องยิงถามฐานข้อมูลก่อน

   แยกออกมาจาก answerFor() เพราะสามอันนี้ต้อง await
   และไม่ควรดึงไว้ล่วงหน้าตอนเปิดกล่องแชท — คนเปิดแชทส่วนใหญ่ถามเรื่องเดียว
   ถ้าดึงทุกอย่างไว้ก่อนจะเสียทั้งเน็ตและโควตา DB ไปกับข้อมูลที่ไม่มีใครดู
   ============================================================ */

const askError = (what) => ({
  text: `ตอนนี้ดึง${what}ไม่ได้ครับ อาจเป็นที่การเชื่อมต่อ ลองใหม่อีกครั้งได้เลย`,
  tone: 'error',
});

/** เมนูร้านกาแฟที่เปิดขายอยู่ตอนนี้ พร้อมราคา */
export async function fetchMenuAnswer() {
  const { data, error } = await supabase.rpc('menu_with_options');
  if (error) {
    console.error('[assistant] ดึงเมนูไม่สำเร็จ:', error);
    return askError('เมนูร้านกาแฟ');
  }

  const products = data?.products || [];
  if (products.length === 0) {
    return {
      text: 'ตอนนี้ร้านยังไม่ได้เปิดเมนูไว้ในระบบครับ',
      actions: [{ label: 'เปิดหน้าสั่งเครื่องดื่ม', path: '/coffee' }],
    };
  }

  // จัดกลุ่มตามหมวดเหมือนหน้าสั่งซื้อ จะได้อ่านเรียงเหมือนกันทั้งสองที่
  const groups = new Map();
  for (const p of products) {
    const key = categoryLabel(p.category);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const lines = [...groups.entries()].map(([label, items]) => {
    const list = items
      .slice(0, 6)
      .map((p) => `  • ${p.name} ${formatBaht(p.price_satang)} ฿`)
      .join('\n');
    const more = items.length > 6 ? `\n  • และอีก ${items.length - 6} รายการ` : '';
    return `**${label}**\n${list}${more}`;
  });

  return {
    text:
      `ร้านมี ${products.length} เมนูที่เปิดขายอยู่ครับ\n\n${lines.join('\n\n')}\n\n` +
      'ราคานี้เป็นราคาเริ่มต้น ยังบวกเพิ่มตามขนาดแก้วกับท็อปปิ้งที่เลือก',
    actions: [{ label: 'สั่งเลย', path: '/coffee' }],
  };
}

/** เวลาเข้าโรงเรียนที่สแกนบัตรไว้ */
export async function fetchGateAnswer() {
  const { data, error } = await supabase.rpc('my_gate_logs', { p_limit: 7 });
  if (error) {
    console.error('[assistant] ดึงเวลาเข้าโรงเรียนไม่สำเร็จ:', error);
    return askError('เวลาเข้าโรงเรียน');
  }

  const logs = Array.isArray(data) ? data : [];
  if (logs.length === 0) {
    return { text: 'ยังไม่มีบันทึกการสแกนบัตรเข้าโรงเรียนของคุณในระบบครับ' };
  }

  const timeText = (iso) =>
    new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));

  const dateOf = (iso) =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date(iso));

  const today = todayISO();
  const todayLog = logs.find((l) => dateOf(l.entered_at) === today);

  const recent = logs
    .slice(0, 5)
    .map((l) => `• ${describeDate(dateOf(l.entered_at))} เวลา ${timeText(l.entered_at)}${l.gate ? ` (${l.gate})` : ''}`)
    .join('\n');

  return {
    text:
      (todayLog
        ? `วันนี้คุณสแกนเข้าโรงเรียนเวลา **${timeText(todayLog.entered_at)}** ครับ`
        : 'วันนี้ยังไม่มีบันทึกการสแกนเข้าโรงเรียนของคุณครับ') +
      `\n\nล่าสุด\n${recent}`,
  };
}

/** เงินเข้า-ออกในบัตรล่าสุด */
export async function fetchWalletAnswer() {
  const { data, error } = await supabase.rpc('my_wallet_history', { p_limit: 6 });
  if (error) {
    console.error('[assistant] ดึงประวัติเงินไม่สำเร็จ:', error);
    return askError('รายการเงินเข้า-ออก');
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return {
      text: 'ยังไม่มีรายการเงินเข้า-ออกในบัตรของคุณครับ',
      actions: [{ label: 'เติมเงิน', path: '/home' }],
    };
  }

  const KIND_LABELS = {
    topup: 'เติมเงิน',
    order: 'สั่งเครื่องดื่ม',
    refund: 'คืนเงิน',
    adjust: 'เจ้าหน้าที่ปรับยอด',
  };

  const lines = rows
    .map((r) => {
      const sign = r.direction === 'in' ? '+' : '-';
      const amount = formatBaht(Math.abs(r.amount_satang));
      const when = r.occurred_at
        ? new Intl.DateTimeFormat('th-TH', {
            timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          }).format(new Date(r.occurred_at))
        : '';
      return `• ${sign}${amount} ฿ ${KIND_LABELS[r.kind] || r.kind}${when ? ` — ${when}` : ''}`;
    })
    .join('\n');

  return {
    text: `รายการล่าสุดในบัตรครับ\n${lines}\n\nยอดคงเหลือหลังรายการล่าสุด ${formatBaht(rows[0].balance_after)} บาท`,
    actions: [{ label: 'ดูทั้งหมด', path: '/home' }],
  };
}

/** ตารางเรียนของวันนี้ พร้อมคาบที่มีครูสอนแทน */
export async function fetchTimetableAnswer(user) {
  const classId = user?.class_id;

  /* ครู/ฝ่ายวิชาการไม่ได้ผูกกับห้องเดียว จึงไม่มี "ตารางของฉัน" ให้ตอบ
     ส่งไปหน้าตารางที่เลือกห้องเองได้ดีกว่าเดาห้องให้ */
  if (!classId) {
    return {
      text: 'บัญชีนี้ไม่ได้ผูกกับห้องเรียนห้องใดห้องหนึ่ง เลือกห้องที่อยากดูได้ในหน้าตารางสอนครับ',
      actions: [{ label: 'เปิดตารางสอน', path: '/timetable' }],
    };
  }

  const today = todayISO();
  const dayKey = weekdayKeyOf(today);

  if (!isSchoolDay(today)) {
    return {
      text: `วัน${DAY_LABELS[dayKey]}ไม่มีคาบเรียนตามตารางปกติครับ`,
      actions: [{ label: 'ดูตารางทั้งสัปดาห์', path: '/timetable' }],
    };
  }

  try {
    const [{ timetable }, subs] = await Promise.all([
      fetchBaseTimetable(classId),
      fetchSubstitutions(classId, today),
    ]);

    const merged = applySubstitutions(timetable, subs, today);
    const periods = merged?.[dayKey] || {};
    const keys = Object.keys(periods)
      .map(Number)
      .filter((n) => periods[n]?.subject)
      .sort((a, b) => a - b);

    if (keys.length === 0) {
      return {
        text: `ยังไม่มีตารางของวัน${DAY_LABELS[dayKey]}สำหรับห้อง ${classLabel(classId)} ในระบบครับ`,
        /* มาถึงตรงนี้ได้เฉพาะบัญชีที่ผูกกับห้อง (นักเรียน) — ป้ายจึงต้องเป็นคำของนักเรียน
           ส่วนสาขาด้านบนที่ไม่มี class_id คือครู/ฝ่ายวิชาการ ยังใช้ "ตารางสอน" ตามเดิม */
        actions: [{ label: `เปิด${timetableTitle(user?.role)}`, path: '/timetable' }],
      };
    }

    const lines = keys.map((p) => {
      const slot = periods[p];
      const room = slot.is_substituted && slot.substitute_room ? slot.substitute_room : slot.room;
      const teacher = slot.is_substituted && slot.substitute_teacher ? slot.substitute_teacher : slot.teacher;
      return (
        `• คาบ ${p} (${PERIOD_TIMES[p] || '-'}) ${slot.subject}` +
        (teacher ? ` — ${teacher}` : '') +
        (room ? ` ห้อง ${room}` : '') +
        (slot.is_substituted ? '  **[สอนแทน]**' : '')
      );
    });

    const subCount = keys.filter((p) => periods[p].is_substituted).length;

    return {
      text:
        `ตารางวัน${DAY_LABELS[dayKey]} ห้อง ${classLabel(classId)} ครับ\n${lines.join('\n')}` +
        (subCount > 0 ? `\n\nวันนี้มีเปลี่ยนครูสอนแทน ${subCount} คาบ` : ''),
      actions: [{ label: 'ดูตารางทั้งสัปดาห์', path: '/timetable' }],
    };
  } catch (err) {
    console.error('[assistant] ดึงตารางเรียนไม่สำเร็จ:', err);
    return askError('ตารางเรียน');
  }
}

/** intent ไหนต้องใช้ตัวดึงข้อมูลแบบ async — AssistantFAB ใช้ตัดสินใจว่าจะ await หรือตอบทันที */
export const ASYNC_ANSWERS = {
  menu: fetchMenuAnswer,
  gate: fetchGateAnswer,
  wallet_history: fetchWalletAnswer,
  timetable: fetchTimetableAnswer,
};

/** ข้อความเปิดตอนเปิดหน้าต่างครั้งแรก
 *
 *  ของเดิมเขียนว่า "ผมดูข้อมูลจริงในระบบให้ได้ และรับแจ้งซ่อมเข้าคิวฝ่ายวิชาการได้ด้วย"
 *  ซึ่งบอกคุณสมบัติของระบบ แต่ไม่ได้บอกสิ่งที่คนเปิดกล่องนี้อยากรู้จริง ๆ ว่า
 *  "แล้วฉันถามอะไรได้บ้าง" — ข้อเสนอแนะจากการรีวิวคือ อ่านแล้วยังไม่เข้าใจว่าใช้ทำอะไร
 *
 *  ตัวใหม่บอกเป็นข้อ ๆ ว่าถามอะไรได้ และแยกตามบทบาท เพราะสิ่งที่ถามได้ไม่เหมือนกัน
 *  (นักเรียนถามยอดเงินตัวเองได้ ครูถามไม่ได้ เพราะเป็นข้อมูลรายบุคคล)
 *  แล้วปิดท้ายด้วยตัวอย่างประโยคจริงหนึ่งประโยค ให้เห็นว่าพิมพ์แบบภาษาพูดได้เลย
 *  ไม่ต้องจำคำสั่ง
 *
 *  รายการของนักเรียนกับครูรวมของที่เพิ่งต่อกับข้อมูลจริงเพิ่มด้วย
 *  (ตารางวันนี้ / เมนูวันนี้ / เวลาเข้าโรงเรียน / รายการเงิน) — ดู ASYNC_ANSWERS
 *  ถ้าเพิ่ม intent ใหม่ที่ตอบจากข้อมูลจริง ต้องมาเติมที่นี่ด้วย ไม่งั้นไม่มีใครรู้ว่าถามได้ */
export function greetingFor(user) {
  const name = user?.name ? `คุณ${user.name}` : '';
  const role = user?.role || 'student';

  const canAsk = {
    student: [
      'ตารางวันนี้ เรียนคาบไหน วิชาอะไร มีสอนแทนไหม',
      'ยอดเงินในบัตร รายการเงินเข้า-ออก และคะแนนความประพฤติ',
      'เมนูร้านกาแฟวันนี้ และเวลาที่คุณสแกนบัตรเข้าโรงเรียน',
      'สถานะใบลาที่ยื่นไว้ และกิจกรรมที่กำลังจะถึง',
      'แจ้งซ่อมอุปกรณ์ในห้อง — ได้เลขที่ใบแจ้งทันที',
    ],
    teacher: [
      'ใบลาที่รอคุณอนุมัติ',
      'เมนูร้านกาแฟวันนี้ และกิจกรรมที่กำลังจะถึงในปฏิทิน',
      'แจ้งซ่อมอุปกรณ์ในห้อง และตามสถานะใบที่แจ้งไว้',
    ],
    academic: [
      'คิวใบแจ้งซ่อมทั้งหมดที่รอดำเนินการ',
      'ใบลาที่รอฝ่ายวิชาการอนุมัติ',
      'กิจกรรมที่กำลังจะถึงในปฏิทิน',
    ],
    barista: [
      'แจ้งซ่อมอุปกรณ์ในร้าน และตามสถานะใบที่แจ้งไว้',
      'จำนวนออเดอร์ที่ยังค้างอยู่ในคิว',
    ],
  };

  const items = canAsk[role] || canAsk.student;

  return {
    text:
      `สวัสดีครับ ${name}\n` +
      'นี่คือผู้ช่วยของ SBAC Connect ถามได้เรื่องพวกนี้ครับ\n' +
      items.map((line, i) => `${i + 1}. ${line}`).join('\n') +
      '\n\nพิมพ์เป็นภาษาพูดได้เลย เช่น **"แอร์ห้อง 315 ไม่เย็น"**\n' +
      'หรือกดปุ่มลัดด้านล่างก็ได้ครับ',
  };
}

/** ข้อความ error ของ submit_repair_ticket -> ภาษาที่ผู้ใช้เข้าใจ */
export function repairErrorText(code) {
  const map = {
    NOT_AUTHENTICATED: 'เซสชันหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่',
    ROOM_REQUIRED: 'ยังไม่ได้ระบุห้อง กรุณาพิมพ์เลขห้องหรือสถานที่',
    PROBLEM_REQUIRED: 'ยังไม่ได้ระบุปัญหา กรุณาอธิบายสั้น ๆ ว่าเสียยังไง',
    PROBLEM_TOO_LONG: 'คำอธิบายยาวเกินไป กรุณาสรุปให้สั้นลง (ไม่เกิน 500 ตัวอักษร)',
    RATE_LIMITED: 'แจ้งซ่อมครบ 5 ใบในชั่วโมงนี้แล้ว กรุณารอสักครู่แล้วลองใหม่',
  };
  return map[code] || 'บันทึกใบแจ้งซ่อมไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
}
