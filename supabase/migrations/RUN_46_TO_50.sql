-- ============================================================================
-- RUN_46_TO_50.sql  —  migration 46 ถึง 50 รวมไว้ในไฟล์เดียว วางรวดเดียวจบ
--
-- สร้างโดยต่อไฟล์ต้นฉบับเข้าด้วยกันตามลำดับ ไม่ได้แก้เนื้อใน SQL แม้แต่ตัวเดียว
-- ต้นทาง: supabase/migrations/46..50 ที่คอมมิต 4d54835
--
-- ⚠️ ก่อนรันไฟล์นี้ ต้องรัน 40_gradebook.sql และ 45_pos_archive_browser.sql ก่อน
--    (สองไฟล์นั้นถูกแก้เพิ่มในรอบเดียวกัน ต้องรันซ้ำ ไม่ใช่ข้ามเพราะเคยรันแล้ว)
--
-- ลำดับในไฟล์นี้: 46 -> 47 -> 48 -> 49 -> 50   (48 ต้องมาหลัง 46 เสมอ)
-- ทุกส่วนเขียนแบบ idempotent รันซ้ำได้ไม่พัง
-- ============================================================================



-- ############################################################################
-- ###  เริ่มไฟล์: 46_bind_subject_teachers.sql
-- ############################################################################

-- ============================================================
-- 46) ผูกครูผู้สอนเข้ากับรายวิชา แล้วรัดสิทธิ์กรอกคะแนนให้แคบลง
--
-- ปัญหาที่แก้
-- ------------
-- app_can_grade_subject ใน 40_gradebook.sql มีกิ่ง fallback เขียนไว้ว่า
--
--     app_has_role('teacher')
--     and (s.teacher_user_id is null or s.teacher_user_id = app_current_user_id())
--
-- เจตนาถูก: กันไม่ให้ฟีเจอร์ตายตั้งแต่วันแรกเพราะยังไม่มีใครผูกครูประจำวิชา
-- แต่ seed ท้ายไฟล์ 40 ใส่ได้แค่ teacher_name ซึ่งเป็น text
-- เพราะ timetables เก็บชื่อครูเป็นข้อความ ไม่มี user id ให้จับคู่
--
-- ผลคือ "ทุกแถว" มี teacher_user_id is null = กิ่ง fallback เป็นจริงกับครูทุกคน
-- fallback ที่ตั้งใจให้เป็นของชั่วคราว กลายเป็นสถานะถาวรของทั้งระบบ
-- ครูคนไหนก็แก้คะแนนเด็กห้องไหนก็ได้ และ delete_score_item ลบหัวข้อทีเดียว
-- คะแนนของนักเรียนทั้งห้องหายตาม (on delete cascade) โดยลบก่อนแล้วค่อยรายงาน
--
-- ไฟล์นี้ทำสองอย่าง: (1) ผูกเท่าที่จับคู่ได้อย่างมั่นใจ (2) รัดกิ่ง fallback
-- รันซ้ำได้ ปลอดภัย
-- ============================================================

-- ------------------------------------------------------------
-- 1) จับคู่ชื่อครูในตารางสอนกับบัญชีผู้ใช้จริง
--
-- ตั้งใจให้ "ไม่ผูก" ปลอดภัยกว่า "ผูกผิด" เพราะผูกผิดแปลว่าครูตัวจริง
-- กรอกคะแนนวิชาตัวเองไม่ได้ แล้วไปโผล่เป็นสิทธิ์ของคนอื่นแทน
-- จึงผูกเฉพาะเมื่อ match ได้ "คนเดียวเท่านั้น" ที่เหลือปล่อยให้คนตัดสิน
-- ------------------------------------------------------------

-- ตัดคำนำหน้าที่ตารางสอนชอบใส่ ('อ.ปิยะนุช' กับ 'ปิยะนุช' ต้องถือว่าเป็นคนเดียวกัน)
create or replace function public.app_norm_teacher_name(p_name text)
returns text
language sql immutable set search_path = pg_catalog, public
as $fn$
  select nullif(
    regexp_replace(
      regexp_replace(coalesce(p_name, ''), '^\s*(อ\.|อาจารย์|ครู|นางสาว|นาง|นาย)\s*', ''),
      '\s+', '', 'g'
    ),
    ''
  );
$fn$;

comment on function public.app_norm_teacher_name(text) is
  'ตัดคำนำหน้าและช่องว่างออกจากชื่อครู ใช้จับคู่ teacher_name จากตารางสอนกับ users.full_name';

do $$
declare
  v_bound int := 0;
begin
  with teachers as (
    -- เฉพาะบัญชีที่มี role teacher จริง และยัง active
    select u.id, public.app_norm_teacher_name(u.full_name) as norm
    from public.users u
    join public.user_roles ur on ur.user_id = u.id and ur.role = 'teacher'
    where u.is_active
      and public.app_norm_teacher_name(u.full_name) is not null
  ),
  -- ชื่อที่ชี้ไปหาครูได้คนเดียวเท่านั้น ชื่อซ้ำกันสองคนขึ้นไปให้ข้าม
  --
  -- ใช้ (array_agg(id))[1] ไม่ใช่ min(id) เพราะ Postgres ไม่มี min() สำหรับ uuid
  -- (ERROR 42883: function min(uuid) does not exist)
  -- having count(*) = 1 การันตีอยู่แล้วว่ากลุ่มนี้มีแถวเดียว จะหยิบตัวไหนก็ตัวเดียวกัน
  unique_names as (
    select norm, (array_agg(id))[1] as user_id
    from teachers
    group by norm
    having count(*) = 1
  )
  update public.subjects s
     set teacher_user_id = un.user_id
    from unique_names un
   where s.teacher_user_id is null
     and public.app_norm_teacher_name(s.teacher_name) = un.norm;

  get diagnostics v_bound = row_count;
  raise notice 'ผูกครูผู้สอนอัตโนมัติได้ % รายวิชา', v_bound;
end $$;

-- ------------------------------------------------------------
-- 2) รัดกิ่ง fallback: วิชาที่ยังไม่ระบุครู ให้เฉพาะครูประจำชั้นของห้องนั้น
--
-- ของเดิมเปิดให้ role teacher "ทุกคนในวิทยาลัย" ซึ่งกว้างเกินความจำเป็นมาก
-- ครูประจำชั้นของห้องนั้นคือคนที่มีเหตุผลจะยุ่งกับคะแนนของห้องนั้นที่สุด
-- ถ้าห้องยังไม่ผูกครูประจำชั้นด้วย ก็ให้ฝ่ายวิชาการจัดการ ไม่ใช่เปิดให้ทุกคน
-- (หลักเดียวกับ app_is_homeroom_teacher_of ใน 22_leave_requests.sql
--  ต่างกันตรงที่ตัวนั้นยอม fallback ให้ครูทุกคนเพื่อกันใบลาค้าง ซึ่งรับได้
--  เพราะใบลาที่อนุมัติผิดคนยังตามแก้ได้ ส่วนคะแนนที่ถูกลบทิ้งไม่มีให้ตามแก้)
-- ------------------------------------------------------------
create or replace function public.app_can_grade_subject(p_subject_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $fn$
  select exists (
    select 1
    from public.subjects s
    join public.class_rooms cr on cr.id = s.class_room_id
    where s.id = p_subject_id
      and (
        app_has_role('academic')
        or app_has_role('sysadmin')
        or (app_has_role('teacher') and s.teacher_user_id = app_current_user_id())
        or (
          app_has_role('teacher')
          and s.teacher_user_id is null
          and cr.homeroom_teacher_id = app_current_user_id()
        )
      )
  );
$fn$;

comment on function public.app_can_grade_subject(uuid) is
  'true เมื่อผู้เรียกมีสิทธิ์กรอก/แก้คะแนนของรายวิชานี้ — ฝ่ายวิชาการได้ทุกวิชา ครูได้วิชาตัวเอง ส่วนวิชาที่ยังไม่ระบุครูได้เฉพาะครูประจำชั้นของห้องนั้น';

grant execute on function public.app_can_grade_subject(uuid) to authenticated;
revoke all on function public.app_can_grade_subject(uuid) from anon;
revoke execute on function public.app_can_grade_subject(uuid) from public;

grant execute on function public.app_norm_teacher_name(text) to authenticated;
revoke all on function public.app_norm_teacher_name(text) from anon;
revoke execute on function public.app_norm_teacher_name(text) from public;

-- ============================================================
-- ตรวจผล — รายการที่ต้องผูกมือ
--
-- แถวที่ขึ้นมาคือวิชาที่ยัง "ไม่มีใครกรอกคะแนนได้เลย" ถ้าห้องนั้นไม่มีครูประจำชั้น
-- หรือ "ครูประจำชั้นกรอกได้คนเดียว" ถ้ามี — ทั้งสองแบบต้องให้ฝ่ายวิชาการผูกครูจริง
-- ============================================================
select
  cr.level || '/' || cr.room_no                      as ห้อง,
  s.name                                             as รายวิชา,
  coalesce(nullif(s.teacher_name, ''), '— ไม่ระบุ —') as ชื่อครูในตารางสอน,
  case when cr.homeroom_teacher_id is null
       then 'ไม่มีใครกรอกได้'
       else 'ครูประจำชั้นกรอกได้คนเดียว'
  end                                                as สถานะตอนนี้
from public.subjects s
join public.class_rooms cr on cr.id = s.class_room_id
where s.teacher_user_id is null
  and s.is_active
order by cr.level, cr.room_no, s.sort_order, s.name;


-- ############################################################################
-- ###  เริ่มไฟล์: 47_fee_guard_and_log.sql
-- ############################################################################

-- ============================================================
-- 47) กันการออกบิลซ้ำทับยอดบิลที่จ่ายแล้ว + ปูมค่าธรรมเนียม
--
-- ปัญหาที่แก้
-- ------------
-- upsert_student_fee() ของไฟล์ 43 หาบิลด้วย (student_user_id, term, trim(title))
-- ถ้าเจอก็ update amount_satang ทับทันที "โดยไม่ดู status เลย"
-- บิลที่ status = 'paid' จึงถูกแก้ยอดได้ ทั้งที่นักเรียนจ่ายเงินไปแล้วจริง
-- และสถานะยังคงเป็น paid อยู่เหมือนเดิม = ยอดที่จ่ายกับยอดที่ระบบบันทึกไม่ตรงกัน
--
-- สามอย่างประกอบกันจนเกิดง่ายมาก:
--   1. ฟังก์ชันไม่ดู status
--   2. หน้าจอออกบิล (IssueFeesPanel) ติ๊กนักเรียน "ทุกคน" มาให้ล่วงหน้า
--   3. ไม่มีปูมค่าธรรมเนียมเลย (ต่างจากคะแนนที่มี score_logs)
-- กด "ออกบิล" ด้วยยอดใหม่ทีเดียว บิลที่จ่ายแล้วทั้งห้องเปลี่ยนยอดเงียบ ๆ
-- แล้วไม่มีทางรู้ย้อนหลังว่าเดิมเท่าไหร่ ใครแก้ ตอนไหน
--
-- ไฟล์นี้แก้ทั้งสามข้อ: ปิดทางเขียนทับ / รายงานจำนวนที่ข้าม / มีปูม
-- รันซ้ำได้ ปลอดภัย
-- ============================================================

-- ------------------------------------------------------------
-- 1) ปูมค่าธรรมเนียม — เทียบเคียง score_logs ของสมุดคะแนน
--
-- เก็บทั้งยอดเดิมและยอดใหม่ ไม่ใช่แค่ "มีการแก้เกิดขึ้น"
-- เพราะคำถามที่ต้องตอบให้ได้คือ "ตกลงเด็กคนนี้ต้องจ่ายเท่าไหร่กันแน่"
-- ------------------------------------------------------------
create table if not exists public.student_fee_logs (
  id              bigint generated always as identity primary key,

  fee_id          bigint not null references public.student_fees(id) on delete cascade,
  student_user_id uuid   not null references public.users(id) on delete cascade,

  -- create = ออกบิลใบใหม่ / amount = แก้ยอด / status = เปลี่ยนสถานะ
  action          text   not null check (action in ('create', 'amount', 'status')),

  old_amount_satang integer,
  new_amount_satang integer,
  old_status        text,
  new_status        text,

  reason          text,
  actor_user_id   uuid references public.users(id),
  created_at      timestamptz not null default now()
);

create index if not exists student_fee_logs_fee_idx
  on public.student_fee_logs (fee_id, created_at desc);
create index if not exists student_fee_logs_student_idx
  on public.student_fee_logs (student_user_id, created_at desc);

comment on table public.student_fee_logs is
  'ปูมการออก/แก้ยอด/เปลี่ยนสถานะบิลค่าธรรมเนียม — ตอบคำถามว่าใครแก้อะไรเมื่อไหร่';

alter table public.student_fee_logs enable row level security;

drop policy if exists student_fee_logs_read_own on public.student_fee_logs;

-- นักเรียนดูปูมบิลของตัวเองได้ ต้องตรวจสอบได้ว่ายอดเปลี่ยนตอนไหน
-- เจ้าหน้าที่การเงินอ่านผ่าน RPC ที่คุมขอบเขต ไม่เปิด policy ให้อ่านทั้งตาราง
-- (หลักเดียวกับ attendance_homeroom ใน 41_homeroom_attendance.sql)
create policy student_fee_logs_read_own on public.student_fee_logs
  for select to authenticated
  using (student_user_id = app_current_user_id());

grant select on public.student_fee_logs to authenticated;
revoke insert, update, delete on public.student_fee_logs from authenticated;
revoke all on public.student_fee_logs from anon;

-- ------------------------------------------------------------
-- 1.5) ปิดช่อง "ไม่มี JWT = มีสิทธิ์เต็ม" ใน app_can_manage_fees()
--
-- ของเดิมเขียนว่า
--     select app_is_finance_staff() or auth.uid() is null;
--
-- เจตนาคืออยากให้รันจาก SQL Editor ได้ ซึ่งสมเหตุสมผล
-- แต่ auth.uid() คืน null ในทุกกรณีที่ JWT ไม่มี claim sub — รวม anon key ด้วย
-- ไม่ใช่เฉพาะ SQL Editor ฟังก์ชันนี้จึงตอบ true ให้ anon
--
-- ตอนนี้ยังเข้าไม่ถึงจริง เพราะทุก RPC ที่กินตัวนี้ถอน anon กับ public ครบแล้ว
-- แต่ความปลอดภัยของเงินค่าเทอมทั้งระบบไปแขวนอยู่กับการที่คนเขียน RPC ตัวถัดไป
-- จะไม่ลืมบรรทัด revoke — ซึ่งไฟล์ 40 ในชุดเดียวกันนี้ลืมทั้ง 15 ตัวมาแล้ว
-- ลืมบรรทัดเดียวบน set_fee_status = ใครก็ได้บนอินเทอร์เน็ตปิดหนี้ค่าเทอมให้ตัวเองได้
--
-- session_user คือสิ่งที่ต้องการจริง: role ที่ "เชื่อมต่อเข้ามา" ไม่ใช่ที่ SET ROLE ไปแล้ว
-- และ SECURITY DEFINER ไม่เปลี่ยนค่านี้ (ต่างจาก current_user)
-- PostgREST เชื่อมด้วย authenticator เสมอ จึงเข้ากิ่งนี้ไม่ได้ทั้ง anon และ authenticated
-- ส่วน SQL Editor เชื่อมด้วย postgres จึงยังออกบิลจาก SQL Editor ได้เหมือนเดิม
--
-- ถ้าโปรเจกต์ของคุณ session_user ไม่ใช่ postgres ให้รัน  select session_user;
-- ใน SQL Editor แล้วเติมค่าที่ได้ลงในลิสต์
-- ------------------------------------------------------------
create or replace function public.app_can_manage_fees()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app_is_finance_staff()
      or session_user in ('postgres', 'supabase_admin');
$$;

comment on function public.app_can_manage_fees() is
  'true เมื่อผู้เรียกเป็นฝ่ายการเงิน/แอดมิน หรือรันจาก SQL Editor โดยตรง — ไม่ใช่ "ไม่มี JWT" ซึ่งครอบ anon ด้วย';

grant execute on function public.app_can_manage_fees() to authenticated;
revoke all     on function public.app_can_manage_fees() from anon;
revoke execute on function public.app_can_manage_fees() from public;

-- ------------------------------------------------------------
-- 2) ออกบิล — ไม่แตะบิลที่ชำระแล้วหรือยกเว้นแล้ว
--
-- ทางเลือกที่ไม่เอา:
--   เขียนทับเงียบ ๆ  -> ของเดิม ทำข้อมูลเสียหายแบบตามแก้ไม่ได้
--   ตอบ error แล้วล้มทั้งชุด -> ออกบิลทั้งห้องพังเพราะมีคนจ่ายไปแล้วคนเดียว
-- ที่เลือก: ข้ามคนนั้นแล้วรายงานกลับไปว่าข้ามกี่คน
-- ฝ่ายการเงินจึงเห็นว่า "ออกใหม่ 12 / แก้ยอด 3 / ข้าม 5" แทนที่จะเห็นแค่ตัวเลขรวม
-- ------------------------------------------------------------
create or replace function public.upsert_student_fee(
  p_student_user_id uuid,
  p_title           text,
  p_amount_satang   integer,
  p_term            text default '1/2569',
  p_due_date        date default null,
  p_note            text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_fee     record;
  v_fee_id  bigint;
  v_created boolean;
  v_amount  text;
  v_me      uuid := app_current_user_id();
begin
  if not app_can_manage_fees() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  if p_amount_satang is null or p_amount_satang <= 0 then
    return jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT');
  end if;

  if not exists (select 1 from public.student_profiles sp where sp.user_id = p_student_user_id) then
    return jsonb_build_object('ok', false, 'error', 'NOT_A_STUDENT');
  end if;

  -- ล็อกแถวไว้ก่อนอ่าน กันสองเครื่องกดออกบิลพร้อมกันแล้วเขียนทับกันเอง
  select * into v_fee
  from public.student_fees
  where student_user_id = p_student_user_id
    and term            = p_term
    and title           = trim(p_title)
  for update;

  v_created := v_fee.id is null;

  -- บิลที่จบแล้ว ห้ามแตะยอด — คืน ok เพื่อไม่ให้ชุดทั้งห้องล้ม แต่ติดธง skipped
  if not v_created and v_fee.status in ('paid', 'waived') then
    return jsonb_build_object(
      'ok',      true,
      'fee_id',  v_fee.id,
      'created', false,
      'skipped', true,
      'reason',  case when v_fee.status = 'paid' then 'ALREADY_PAID' else 'ALREADY_WAIVED' end,
      'amount_satang', v_fee.amount_satang
    );
  end if;

  if v_created then
    insert into public.student_fees
      (student_user_id, title, term, amount_satang, due_date, note, created_by)
    values
      (p_student_user_id, trim(p_title), p_term, p_amount_satang, p_due_date, p_note, v_me)
    returning id into v_fee_id;

    insert into public.student_fee_logs
      (fee_id, student_user_id, action, new_amount_satang, new_status, actor_user_id)
    values
      (v_fee_id, p_student_user_id, 'create', p_amount_satang, 'unpaid', v_me);
  else
    v_fee_id := v_fee.id;

    update public.student_fees
       set amount_satang = p_amount_satang,
           due_date      = coalesce(p_due_date, due_date),
           note          = coalesce(nullif(trim(p_note), ''), note),
           updated_at    = now()
     where id = v_fee_id;

    -- ลงปูมเฉพาะตอนยอดเปลี่ยนจริง กดออกบิลซ้ำด้วยยอดเดิมไม่ต้องมีแถวขยะ
    if v_fee.amount_satang is distinct from p_amount_satang then
      insert into public.student_fee_logs
        (fee_id, student_user_id, action, old_amount_satang, new_amount_satang, old_status, new_status, actor_user_id)
      values
        (v_fee_id, p_student_user_id, 'amount', v_fee.amount_satang, p_amount_satang, v_fee.status, v_fee.status, v_me);
    end if;
  end if;

  -- แจ้งเตือนเฉพาะตอนออกบิลใหม่ ไม่ใช่ตอนแก้ยอดบิลเดิม
  if v_created then
    v_amount := to_char(p_amount_satang / 100.0, 'FM999,999,990.00');

    insert into public.notifications (user_id, type, title, body, data)
    values (
      p_student_user_id,
      'fee_new',
      '💰 มีรายการค้างชำระใหม่',
      trim(p_title) || ' ' || p_term || ' จำนวน ' || v_amount || ' บาท' ||
      case when p_due_date is null then '' else ' — ครบกำหนด ' || to_char(p_due_date, 'DD/MM/') || (extract(year from p_due_date)::int + 543)::text end,
      jsonb_build_object('fee_id', v_fee_id, 'amount_satang', p_amount_satang, 'term', p_term)
    );
  end if;

  return jsonb_build_object('ok', true, 'fee_id', v_fee_id, 'created', v_created, 'skipped', false);
end $$;

comment on function public.upsert_student_fee(uuid, text, integer, text, date, text) is
  'ฝ่ายการเงินออกบิลค่าธรรมเนียมให้นักเรียนหนึ่งคน — บิลที่ชำระแล้ว/ยกเว้นแล้วจะถูกข้าม ไม่เขียนทับยอด';

grant execute on function public.upsert_student_fee(uuid, text, integer, text, date, text) to authenticated;
revoke all     on function public.upsert_student_fee(uuid, text, integer, text, date, text) from anon;
revoke execute on function public.upsert_student_fee(uuid, text, integer, text, date, text) from public;

-- ------------------------------------------------------------
-- 3) ออกบิลหลายคน — นับ skipped แยกออกมา
-- ------------------------------------------------------------
create or replace function public.create_fees_for_students(
  p_student_ids   uuid[],
  p_title         text,
  p_amount_satang integer,
  p_term          text default '1/2569',
  p_due_date      date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_result  jsonb;
  v_created int := 0;
  v_skipped int := 0;
  v_total   int := 0;
  v_failed  int := 0;
begin
  if not app_can_manage_fees() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  if p_student_ids is null or array_length(p_student_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'NO_STUDENTS');
  end if;

  if p_amount_satang is null or p_amount_satang <= 0 then
    return jsonb_build_object('ok', false, 'error', 'BAD_AMOUNT');
  end if;

  if p_title is null or char_length(trim(p_title)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'BAD_TITLE');
  end if;

  foreach v_id in array p_student_ids loop
    v_result := public.upsert_student_fee(v_id, p_title, p_amount_satang, p_term, p_due_date, null);
    v_total  := v_total + 1;

    if coalesce((v_result->>'ok')::boolean, false) then
      if coalesce((v_result->>'skipped')::boolean, false) then
        v_skipped := v_skipped + 1;
      elsif coalesce((v_result->>'created')::boolean, false) then
        v_created := v_created + 1;
      end if;
    else
      v_failed := v_failed + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'students', v_total,
    'created',  v_created,
    'skipped',  v_skipped,   -- จ่ายแล้ว/ยกเว้นแล้ว ไม่แตะยอด
    'updated',  v_total - v_created - v_skipped - v_failed,
    'failed',   v_failed
  );
end $$;

comment on function public.create_fees_for_students(uuid[], text, integer, text, date) is
  'ออกบิลให้นักเรียนหลายคนตามรายชื่อที่เลือก — คนที่ชำระแล้ว/ยกเว้นแล้วจะถูกข้ามและรายงานกลับเป็น skipped';

grant execute on function public.create_fees_for_students(uuid[], text, integer, text, date) to authenticated;
revoke all     on function public.create_fees_for_students(uuid[], text, integer, text, date) from anon;
revoke execute on function public.create_fees_for_students(uuid[], text, integer, text, date) from public;

-- ------------------------------------------------------------
-- 4) ออกบิลทั้งห้อง — นับ skipped เหมือนกัน
-- ------------------------------------------------------------
create or replace function public.create_class_fees(
  p_class_room_id bigint,
  p_title         text,
  p_amount_satang integer,
  p_term          text default '1/2569',
  p_due_date      date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  r         record;
  v_result  jsonb;
  v_created int := 0;
  v_skipped int := 0;
  v_total   int := 0;
begin
  if not app_can_manage_fees() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  for r in
    select sp.user_id
    from public.student_profiles sp
    where sp.class_room_id = p_class_room_id
  loop
    v_result := public.upsert_student_fee(r.user_id, p_title, p_amount_satang, p_term, p_due_date, null);
    v_total  := v_total + 1;

    if coalesce((v_result->>'skipped')::boolean, false) then
      v_skipped := v_skipped + 1;
    elsif coalesce((v_result->>'created')::boolean, false) then
      v_created := v_created + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'students', v_total, 'created', v_created, 'skipped', v_skipped
  );
end $$;

grant execute on function public.create_class_fees(bigint, text, integer, text, date) to authenticated;
revoke all     on function public.create_class_fees(bigint, text, integer, text, date) from anon;
revoke execute on function public.create_class_fees(bigint, text, integer, text, date) from public;

-- ------------------------------------------------------------
-- 5) รายชื่อนักเรียนในห้อง — บอกด้วยว่าใครมีบิลชื่อนี้ของเทอมนี้อยู่แล้ว
--
-- ของเดิมคืนแค่ยอดค้างรวม หน้าจอจึงไม่มีทางรู้ว่าใครจ่ายบิลใบนี้ไปแล้ว
-- แล้วติ๊กทุกคนมาให้ล่วงหน้า ซึ่งเป็นเหตุให้กดออกบิลทับได้ง่าย
--
-- ต้อง drop ก่อน เพราะเพิ่มพารามิเตอร์ = ลายเซ็นใหม่
-- ถ้าไม่ drop จะมีสองตัวชื่อเดียวกันแล้ว PostgREST เลือกไม่ถูก
-- ------------------------------------------------------------
drop function if exists public.list_fee_class_students(bigint);

create or replace function public.list_fee_class_students(
  p_class_room_id bigint,
  p_term          text default null,
  p_title         text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_students jsonb;
  v_title    text := nullif(trim(coalesce(p_title, '')), '');
begin
  if not app_can_manage_fees() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  if p_class_room_id is null then
    return jsonb_build_object('ok', true, 'students', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    into v_students
  from (
    select u.id          as user_id,
           u.full_name,
           sp.student_code,
           coalesce((select sum(f.amount_satang)
                       from public.student_fees f
                      where f.student_user_id = u.id
                        and f.status in ('unpaid', 'pending')), 0) as outstanding_satang,
           -- สถานะของบิล "ชื่อนี้ เทอมนี้" โดยเฉพาะ — null = ยังไม่เคยออกให้คนนี้
           (select f.status
              from public.student_fees f
             where f.student_user_id = u.id
               and v_title is not null
               and p_term is not null
               and f.term  = p_term
               and f.title = v_title
             limit 1)                                             as existing_status
    from public.student_profiles sp
    join public.users u on u.id = sp.user_id
    where sp.class_room_id = p_class_room_id
    order by sp.student_code, u.full_name
  ) x;

  return jsonb_build_object('ok', true, 'students', v_students);
end $$;

comment on function public.list_fee_class_students(bigint, text, text) is
  'รายชื่อนักเรียนในห้อง พร้อมยอดค้างรวม และสถานะบิลชื่อ/เทอมที่ระบุ (existing_status) สำหรับหน้าออกบิล';

grant execute on function public.list_fee_class_students(bigint, text, text) to authenticated;
revoke all     on function public.list_fee_class_students(bigint, text, text) from anon;
revoke execute on function public.list_fee_class_students(bigint, text, text) from public;

-- ------------------------------------------------------------
-- 6) เปลี่ยนสถานะ — ของเดิมทั้งดุ้น บวกการลงปูม
--
-- ชื่อพารามิเตอร์ต้องคงเป็น p_note เหมือนเดิมห้ามเปลี่ยน
-- PostgREST เรียก RPC ด้วยชื่อพารามิเตอร์ (useFinanceFees.js ส่ง p_note มา)
-- เปลี่ยนชื่อเมื่อไหร่ฝั่งเว็บพังทันทีโดยที่ SQL ยังรันผ่าน
--
-- ตรรกะแจ้งเตือนคัดลอกมาจากไฟล์ 43 ทั้งหมดโดยไม่แก้ เพราะทำงานถูกอยู่แล้ว
-- ที่เพิ่มคือบล็อก insert ลง student_fee_logs ท้ายสุดเท่านั้น
-- ------------------------------------------------------------
create or replace function public.set_fee_status(
  p_fee_id bigint,
  p_status text,
  p_note   text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_fee    record;
  v_amount text;
  v_title  text;
  v_body   text;
begin
  if not app_can_manage_fees() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  if p_status not in ('unpaid', 'pending', 'paid', 'waived') then
    return jsonb_build_object('ok', false, 'error', 'BAD_STATUS');
  end if;

  -- ล็อกแถวก่อน กันการเงินสองเครื่องกดยืนยันใบเดียวกันพร้อมกัน
  select * into v_fee from public.student_fees where id = p_fee_id for update;

  if v_fee.id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  update public.student_fees
     set status       = p_status,
         note         = coalesce(nullif(trim(p_note), ''), note),
         paid_at      = case when p_status = 'paid' then coalesce(paid_at, now()) else null end,
         confirmed_by = case when p_status in ('paid', 'waived') then app_current_user_id() else null end,
         updated_at   = now()
   where id = p_fee_id;

  v_amount := to_char(v_fee.amount_satang / 100.0, 'FM999,999,990.00');

  -- เงียบไว้ถ้าสถานะไม่ได้เปลี่ยน — กันแจ้งเตือนซ้ำเวลาการเงินกดยืนยันรอบสอง
  if p_status is distinct from v_fee.status then
    if p_status = 'paid' then
      v_title := '✅ ยืนยันการชำระเงินแล้ว';
      v_body  := v_fee.title || ' ' || v_fee.term || ' จำนวน ' || v_amount || ' บาท — ชำระครบแล้ว ขอบคุณครับ/ค่ะ';
    elsif p_status = 'waived' then
      v_title := '🎓 ได้รับการยกเว้นค่าธรรมเนียม';
      v_body  := v_fee.title || ' ' || v_fee.term || ' จำนวน ' || v_amount || ' บาท — ไม่ต้องชำระ';
    elsif p_status = 'unpaid' and v_fee.status = 'pending' then
      v_title := '⚠️ ยังตรวจไม่พบเงินเข้าบัญชี';
      v_body  := v_fee.title || ' ' || v_fee.term || ' จำนวน ' || v_amount ||
                 ' บาท — กรุณาติดต่อฝ่ายการเงินพร้อมสลิปโอนเงิน';
    else
      v_title := '📄 รายการค่าธรรมเนียมถูกปรับสถานะ';
      v_body  := v_fee.title || ' ' || v_fee.term || ' จำนวน ' || v_amount || ' บาท';
    end if;

    insert into public.notifications (user_id, type, title, body, data)
    values (
      v_fee.student_user_id,
      'fee_' || p_status,
      v_title,
      v_body,
      jsonb_build_object('fee_id', v_fee.id, 'status', p_status, 'amount_satang', v_fee.amount_satang)
    );

    -- ปูม: ใครเปลี่ยนสถานะบิลใบไหน จากอะไรเป็นอะไร ด้วยเหตุผลอะไร
    insert into public.student_fee_logs
      (fee_id, student_user_id, action, old_status, new_status,
       old_amount_satang, new_amount_satang, reason, actor_user_id)
    values
      (v_fee.id, v_fee.student_user_id, 'status', v_fee.status, p_status,
       v_fee.amount_satang, v_fee.amount_satang, nullif(trim(coalesce(p_note, '')), ''), app_current_user_id());
  end if;

  return jsonb_build_object('ok', true, 'fee_id', v_fee.id, 'status', p_status);
end $$;

comment on function public.set_fee_status(bigint, text, text) is
  'ฝ่ายการเงินปรับสถานะรายการค่าธรรมเนียม พร้อมแจ้งเตือนนักเรียนและลงปูมใน student_fee_logs';

grant execute on function public.set_fee_status(bigint, text, text) to authenticated;
revoke all     on function public.set_fee_status(bigint, text, text) from anon;
revoke execute on function public.set_fee_status(bigint, text, text) from public;

-- ============================================================
-- ตรวจผล
-- ============================================================
do $$
declare
  v_bad int := 0;
  r record;
begin
  if to_regclass('public.student_fee_logs') is null then
    raise warning 'ไม่พบตาราง student_fee_logs'; v_bad := v_bad + 1;
  end if;

  for r in
    select p.oid::regprocedure::text as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('upsert_student_fee','create_fees_for_students','create_class_fees',
                        'list_fee_class_students','set_fee_status')
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    raise warning 'anon ยังเรียกได้: %', r.f; v_bad := v_bad + 1;
  end loop;

  if v_bad = 0 then
    raise notice 'ผ่าน — บิลที่ชำระแล้วถูกกันไว้ ปูมพร้อมใช้ และ anon เรียก RPC การเงินไม่ได้';
  end if;
end $$;


-- ############################################################################
-- ###  เริ่มไฟล์: 48_gradebook_read_scope.sql
-- ############################################################################

-- ============================================================
-- 48) รัดขอบเขตการอ่านคะแนน + ปิดช่องคะแนนรั่วทาง realtime
--
-- แก้สองเรื่องที่ 40_gradebook.sql เปิดกว้างเกินจำเป็น
-- รันหลังไฟล์ 40 (และ 46 ถ้ามี) รันซ้ำได้
-- ============================================================

-- ------------------------------------------------------------
-- 1) ครูอ่านคะแนนได้เฉพาะวิชาที่ตัวเองรับผิดชอบ ไม่ใช่ทั้งวิทยาลัย
--
-- ของเดิม:
--     using (student_user_id = app_current_user_id() or app_is_teaching_staff())
--
-- ฝั่งนักเรียนถูกต้องแล้วและบรรลุผลจริง — นักเรียนอ่านคะแนนเพื่อนไม่ได้
-- ปัญหาอยู่ที่กิ่งหลัง: app_is_teaching_staff() = teacher หรือ academic หรือ sysadmin
-- ไม่ผูกกับห้องหรือวิชาเลย ครูคนไหนก็ยิง GET /rest/v1/student_scores?select=*
-- ได้คะแนนทุกช่องของนักเรียนทุกคนทั้งวิทยาลัย และ score_logs ก็ได้เหตุผล
-- ที่ครูคนอื่นเขียนถึงเด็กคนอื่นทั้งหมด ("ลอกข้อสอบ", "ไม่ส่งงาน")
--
-- ที่ทำให้เรื่องนี้เป็นปัญหาไม่ใช่แค่ความเห็น: ไฟล์ 41 ในชุดเดียวกันตั้งหลักตรงข้ามไว้เอง
--   "ถ้าเปิด policy ให้ครูอ่านทั้งตาราง = ครูทุกคนเห็นสถานะเด็กทั้งวิทยาลัยโดยไม่จำเป็น"
-- คะแนนอ่อนไหวกว่าสถานะเข้าแถว แต่ได้การป้องกันที่หลวมกว่า
--
-- ทำไมไม่ถอดกิ่งครูทิ้งไปเลย:
--   หน้าสมุดคะแนนของครู subscribe realtime บนตารางนี้อยู่ (useGradebook.js:192)
--   ถ้าครูอ่านแถวไม่ได้เลย Supabase Realtime จะไม่ส่ง event ให้ = กรอกคะแนนแล้ว
--   หน้าจอครูอีกเครื่องไม่ขยับ ซึ่งเป็นอาการที่โปรเจกต์นี้พยายามกำจัดมาตลอด
--   จึงรัดให้แคบลงแทนที่จะตัดทิ้ง: เห็นเฉพาะวิชาที่ตัวเองมีสิทธิ์กรอก
--   (ฝ่ายวิชาการ/แอดมินยังเห็นทุกวิชา เพราะ app_can_grade_subject มีกิ่งนั้นอยู่แล้ว)
-- ------------------------------------------------------------
drop policy if exists student_scores_read on public.student_scores;
create policy student_scores_read on public.student_scores
  for select to authenticated
  using (
    student_user_id = app_current_user_id()
    or app_can_grade_subject(subject_id)
  );

drop policy if exists score_logs_read on public.score_logs;
create policy score_logs_read on public.score_logs
  for select to authenticated
  using (
    student_user_id = app_current_user_id()
    or app_can_grade_subject(subject_id)
  );

-- ------------------------------------------------------------
-- 2) subject_gradebook() — ตรวจสิทธิ์ระดับวิชา ไม่ใช่แค่ "เป็นครูหรือเปล่า"
--
-- ของเดิมด่านเดียวคือ app_is_teaching_staff() แล้วคืนตารางคะแนนเต็มรูป
-- พร้อมชื่อและรหัสนักเรียนของห้องนั้น ครูคนไหนก็ดึงของทุกห้องทุกวิชาได้
-- ส่วน can_grade ที่ฟังก์ชันคืนมาเป็น "ธงให้หน้าเว็บปิดปุ่ม" ไม่ใช่ด่าน
--
-- ไม่แตะส่วนอื่นของฟังก์ชันเลย เปลี่ยนแค่บรรทัดด่าน
-- ------------------------------------------------------------
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(p.oid) into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'subject_gradebook'
  limit 1;

  if v_src is null then
    raise warning 'ยังไม่มี subject_gradebook() — รัน 40_gradebook.sql ก่อน แล้วค่อยรันไฟล์นี้ใหม่';
    return;
  end if;

  if position('app_can_grade_subject(p_subject_id)' in v_src) > 0 then
    raise notice 'subject_gradebook() มีด่านระดับวิชาแล้ว ข้ามไป';
    return;
  end if;

  -- แทนที่ด่านเดิมด้วยด่านระดับวิชา โดยไม่แตะตรรกะที่เหลือ
  declare
    v_new text := replace(
      v_src,
      'if not app_is_teaching_staff() then',
      'if not app_can_grade_subject(p_subject_id) then'
    );
  begin
    -- ถ้าแทนที่ไม่ติด (ของเดิมเขียนคนละรูปแบบ) ต้องดังไว้ ไม่ใช่ execute ของเดิมกลับเข้าไปเฉย ๆ
    -- แล้วขึ้น notice ว่าสำเร็จทั้งที่ไม่ได้แก้อะไรเลย
    if v_new = v_src then
      raise warning 'แทนที่ด่านใน subject_gradebook() ไม่ติด — ต้องแก้มือให้ใช้ app_can_grade_subject(p_subject_id)';
      return;
    end if;

    execute v_new;
    raise notice 'รัดด่าน subject_gradebook() ให้ตรวจสิทธิ์ระดับวิชาแล้ว';
  end;
end $$;

-- ------------------------------------------------------------
-- 3) ปิดช่องคะแนนรั่วตอนครูล้างคะแนน (เหตุการณ์ DELETE ทาง realtime)
--
-- apply_score_change() ลบแถวจริงเมื่อครูล้างคะแนน (40_gradebook.sql)
-- และตารางนี้ถูกตั้ง replica identity full ไว้ = เหตุการณ์ DELETE จะพ่วง
-- แถวเก่าทั้งแถวออกไป (student_user_id, item_id, score, note)
--
-- Supabase Realtime กรอง RLS ได้กับ INSERT/UPDATE แต่ไม่กรอง DELETE
-- เพราะแถวถูกลบไปแล้ว ประเมิน policy ไม่ได้ นักเรียนที่เปิดหน้าคะแนนค้างไว้
-- จึงมีโอกาสได้คะแนนของเพื่อนทุกครั้งที่ครูล้างคะแนนใครสักคน
-- ขัดกับบรรทัดที่ไฟล์ 40 เขียนไว้เองว่า "นักเรียนต้องไม่เห็นคะแนนเพื่อนแม้แต่แถวเดียว"
--
-- แก้ที่ replica identity แทนการเลิกลบแถว เพราะ:
--   คอมเมนต์ในไฟล์ 40 บอกว่าตั้ง full ไว้เพื่อให้หน้าเว็บ "กรองตามนักเรียนได้"
--   แต่ไล่โค้ดฝั่งเว็บแล้วไม่มีที่ไหนใช้ payload เลย — useRealtimeTable เรียกแค่
--   () => onChange() เพื่อสั่งโหลดใหม่ผ่าน RPC และไม่มีใครส่ง filter มาสักที่
--   เจตนานั้นจึงไม่เคยถูกเขียนจริง ลดเหลือ default (ส่งแค่ primary key)
--   จึงไม่กระทบฟีเจอร์ใด ๆ แต่ปิดช่องรั่วทั้งช่อง
--
-- subjects กับ score_items ไม่แตะ — เป็นโครงสร้างรายวิชา ไม่มีข้อมูลรายบุคคล
-- ------------------------------------------------------------
alter table public.student_scores replica identity default;

-- ============================================================
-- ตรวจผล
-- ============================================================
do $$
declare
  v_bad int := 0;
  v_ident char;
  v_using text;
begin
  select relreplident into v_ident from pg_class where relname = 'student_scores';
  if v_ident is distinct from 'd' then
    raise warning 'student_scores replica identity ยังไม่ใช่ default (ได้ %)', v_ident;
    v_bad := v_bad + 1;
  end if;

  for v_using in
    select pg_get_expr(pol.polqual, pol.polrelid)
    from pg_policy pol
    join pg_class c on c.oid = pol.polrelid
    where c.relname in ('student_scores', 'score_logs')
  loop
    if position('app_is_teaching_staff' in v_using) > 0 then
      raise warning 'ยังมี policy ที่เปิดให้เจ้าหน้าที่สอนอ่านทั้งตาราง: %', v_using;
      v_bad := v_bad + 1;
    end if;
  end loop;

  if v_bad = 0 then
    raise notice 'ผ่าน — ครูอ่านคะแนนได้เฉพาะวิชาที่รับผิดชอบ และ DELETE ไม่พ่วงคะแนนออกไปแล้ว';
  end if;
end $$;


-- ############################################################################
-- ###  เริ่มไฟล์: 49_pos_archive_totals.sql
-- ############################################################################

-- ============================================================
-- 49) ยอดรวมในคลังบิลต้องไม่นับบิลที่ยกเลิก
--
-- pos_archive_orders() ของไฟล์ 17 ยอมเก็บเข้าคลังทั้ง status 'done' และ 'cancelled'
--   update orders set archived_at = now() where ... and status in ('done', 'cancelled')
-- ส่วน CTE matched ใน pos_archived_orders() กรองแค่ archived_at is not null
-- แล้ว sum(total_satang) ทับทั้งก้อน
--
-- ผลคือ "ยอดรวมทั้งหมด" ที่หน้าร้านเห็น สูงกว่ายอดขายจริงเท่ากับมูลค่าบิลที่ยกเลิก
-- ซึ่งเป็นตัวเลขที่บาริสต้าใช้กระทบยอดปลายวัน — ผิดแล้วไปโทษเงินในลิ้นชักแทน
--
-- แก้โดยแยกให้ชัดสามค่า ไม่ใช่ซ่อนบิลยกเลิกไป:
--   total_satang    ยอดขายจริง (เฉพาะ done)
--   cancelled_count จำนวนใบที่ยกเลิก
--   count           จำนวนใบทั้งหมดที่ตรงเงื่อนไขค้น (เท่าเดิม)
-- บิลที่ยกเลิกยังต้องค้นเจอได้อยู่ เพราะลูกค้ามาถามว่า "ที่ยกเลิกไปเมื่อวานคือใบไหน"
--
-- รันซ้ำได้
-- ============================================================
create or replace function public.pos_archived_orders(
  p_search text default null,
  p_from   date default null,
  p_to     date default null,
  p_limit  int  default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_q        text := nullif(trim(coalesce(p_search, '')), '');
  v_limit    int  := greatest(1, least(coalesce(p_limit, 100), 200));
  v_count    int;
  v_total    bigint;
  v_cancel   int;
  v_orders   jsonb;
begin
  if not app_is_pos_staff() then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  /* คำสั่งเดียวจบทั้งยอดรวมและใบที่เอามาแสดง โดยมีเงื่อนไขการค้นเขียนไว้ที่เดียว (matched)
     ถ้าแยกเป็นสองคำสั่ง วันหนึ่งมีคนแก้เงื่อนไขที่หนึ่งแล้วลืมอีกที่
     ยอดรวมกับรายการที่เห็นจะไม่ตรงกันแบบเงียบ ๆ ซึ่งจับได้ยากมาก

     เพิ่ม o.status เข้ามาใน matched เพื่อให้แยกยอดขายจริงออกจากบิลที่ยกเลิกได้
     โดยที่เงื่อนไขการค้นยังอยู่ที่เดียวเหมือนเดิม */
  with matched as (
    select o.id, o.total_satang, o.created_at, o.status
    from orders o
    join users u on u.id = o.user_id
    left join student_profiles sp on sp.user_id = o.user_id
    where o.archived_at is not null
      and (p_from is null or (o.created_at at time zone 'Asia/Bangkok')::date >= p_from)
      and (p_to   is null or (o.created_at at time zone 'Asia/Bangkok')::date <= p_to)
      and (
        v_q is null
        or o.pickup_code ilike '%' || v_q || '%'
        or u.full_name   ilike '%' || v_q || '%'
        or coalesce(sp.student_code, '') ilike '%' || v_q || '%'
      )
  ),
  page as (
    select id from matched order by created_at desc limit v_limit
  ),
  bills as (
    select coalesce(jsonb_agg(row_to_json(b)::jsonb order by b.created_at desc), '[]'::jsonb) as list
    from (
      select
        o.id,
        o.total_satang,
        o.status,
        o.pickup_code,
        o.note                                     as order_note,
        o.created_at,
        o.archived_at,
        u.full_name                                as student_name,
        coalesce(sp.student_code, '')              as student_code,
        coalesce((
          select jsonb_agg(jsonb_build_object(
                   'name',              p.name,
                   'qty',               oi.qty,
                   'unit_price_satang', oi.unit_price_satang,
                   'category',          p.category,
                   'note',              oi.note,
                   'options', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'group', oio.group_name,
                              'name',  oio.option_name,
                              'price_delta_satang', oio.price_delta_satang)
                            order by oio.group_name, oio.option_name)
                     from order_item_options oio
                     where oio.order_item_id = oi.id
                   ), '[]'::jsonb))
                 order by oi.id)
          from order_items oi
          join products p on p.id = oi.product_id
          where oi.order_id = o.id
        ), '[]'::jsonb)                            as items
      from page
      join orders o on o.id = page.id
      join users u on u.id = o.user_id
      left join student_profiles sp on sp.user_id = o.user_id
    ) b
  )
  select
    (select count(*) from matched),
    -- ยอดขายจริง: เฉพาะใบที่ทำเสร็จ ไม่รวมที่ยกเลิก
    (select coalesce(sum(total_satang), 0) from matched where status = 'done'),
    (select count(*) from matched where status = 'cancelled'),
    (select list from bills)
  into v_count, v_total, v_cancel, v_orders;

  return jsonb_build_object(
    'ok', true,
    'orders', v_orders,
    'summary', jsonb_build_object(
      'count',           v_count,     -- ทั้งหมดที่ตรงเงื่อนไข (รวมที่ยกเลิก)
      'shown',           jsonb_array_length(v_orders),
      'total_satang',    v_total,     -- ยอดขายจริง เฉพาะ done
      'cancelled_count', v_cancel,
      'limit',           v_limit
    )
  );
end $fn$;

comment on function public.pos_archived_orders(text, date, date, int) is
  'ค้นบิลที่ถูกเก็บเข้าคลัง — total_satang นับเฉพาะบิลที่ทำเสร็จ ส่วนบิลที่ยกเลิกยังค้นเจอได้และนับแยกใน cancelled_count';

grant execute on function public.pos_archived_orders(text, date, date, int) to authenticated;
revoke all     on function public.pos_archived_orders(text, date, date, int) from anon;
revoke execute on function public.pos_archived_orders(text, date, date, int) from public;


-- ############################################################################
-- ###  เริ่มไฟล์: 50_my_attendance_history.sql
-- ############################################################################

-- ============================================================
-- 50) นักเรียนดูประวัติการเช็คชื่อของตัวเองได้
--
-- ครูประจำชั้นบันทึก มา/สาย/ขาด/ลา ลง attendance_homeroom ทุกวัน
-- และนักเรียนได้แจ้งเตือนรายวันเมื่อสถานะเปลี่ยน
-- แต่ไม่มีหน้าไหนในแอปที่สรุปให้เจ้าตัวดูย้อนหลังได้เลย
--
-- คำถามที่ตอบไม่ได้ตอนนี้: "เทอมนี้ฉันขาดไปกี่วันแล้ว"
-- ซึ่งเป็นตัวเลขที่มีผลกับการจบการศึกษา และเป็นข้อมูลของตัวเขาเอง
--
-- policy attendance_homeroom_read_own (41_homeroom_attendance.sql) เปิดให้อ่าน
-- ของตัวเองได้อยู่แล้ว แต่ทำเป็น RPC ตามแบบ my_* ตัวอื่นในโปรเจกต์
-- เพราะต้องนับสรุปฝั่ง DB และไม่รับ user id จึงถามแทนคนอื่นไม่ได้
--
-- รันซ้ำได้
-- ============================================================
create or replace function public.my_attendance_history(p_limit integer default 60)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me    uuid := app_current_user_id();
  v_limit int  := greatest(1, least(coalesce(p_limit, 60), 200));
  v_rows  jsonb;
  v_sum   record;
begin
  if v_me is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  -- สรุปทั้งหมดที่มี ไม่ใช่แค่ช่วงที่ส่งกลับไปแสดง
  -- ไม่งั้นตัวเลข "ขาด 3 วัน" จะหมายถึง "ขาด 3 วันใน 60 วันล่าสุด" ซึ่งคนละความหมาย
  select
    count(*)                                          as total,
    count(*) filter (where status = 'present')        as present,
    count(*) filter (where status = 'late')           as late,
    count(*) filter (where status = 'absent')         as absent,
    count(*) filter (where status = 'leave')          as leave_count
  into v_sum
  from public.attendance_homeroom
  where student_user_id = v_me;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.attend_date desc), '[]'::jsonb)
    into v_rows
  from (
    select a.attend_date, a.status
    from public.attendance_homeroom a
    where a.student_user_id = v_me
    order by a.attend_date desc
    limit v_limit
  ) x;

  return jsonb_build_object(
    'ok', true,
    'days', v_rows,
    'summary', jsonb_build_object(
      'total',   v_sum.total,
      'present', v_sum.present,
      'late',    v_sum.late,
      'absent',  v_sum.absent,
      'leave',   v_sum.leave_count
    )
  );
end $fn$;

comment on function public.my_attendance_history(integer) is
  'ประวัติการเช็คชื่อเข้าแถวของผู้เรียกเอง พร้อมสรุปรวมทั้งหมด — ไม่รับ user id จึงดูแทนคนอื่นไม่ได้';

grant execute on function public.my_attendance_history(integer) to authenticated;
revoke all     on function public.my_attendance_history(integer) from anon;
revoke execute on function public.my_attendance_history(integer) from public;

-- ============================================================
-- ตรวจผล
-- ============================================================
do $$
begin
  if to_regprocedure('public.my_attendance_history(integer)') is null then
    raise warning 'ไม่พบ my_attendance_history';
  elsif has_function_privilege('anon', 'public.my_attendance_history(integer)', 'execute') then
    raise warning 'anon ยังเรียก my_attendance_history ได้';
  else
    raise notice 'ผ่าน — นักเรียนดูประวัติเช็คชื่อของตัวเองได้ และ anon เรียกไม่ได้';
  end if;
end $$;

-- ############################################################################
-- ###  จบไฟล์รวม — ครบทั้ง 46, 47, 48, 49, 50
-- ############################################################################
