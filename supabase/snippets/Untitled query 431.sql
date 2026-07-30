insert into orders (phone_number, order_id, customer_name, delivery_address, status)
values ('08116411177', 'ORD12345', 'Divya', 'Kalimpong, West Bengal', 'pending')
on conflict (phone_number) do update 
set order_id = excluded.order_id;