create table if not exists orders (
  id serial primary key,
  phone_number text,
  order_id text
);

create table if not exists ivr_logs (
  id serial primary key,
  call_sid text,
  caller_number text,
  order_id text,
  step text,
  user_input text,
  status text,
  created_at timestamp with time zone
);