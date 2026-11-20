-- Domain duy nhất trong bản ghi chưa xóa mềm.
BEGIN;
SELECT itso_test.seed();

SELECT itso_test.expect_ok('Thêm domain phụ',
  $$INSERT INTO domains (id, website_id, name) VALUES (1, 1, 'www.a.example.vn')$$);
SELECT itso_test.expect_error('Domain trùng (deleted_at NULL) bị từ chối',
  $$INSERT INTO domains (website_id, name) VALUES (1, 'www.a.example.vn')$$, '23505');
SELECT itso_test.expect_ok('Xóa mềm domain',
  $$UPDATE domains SET deleted_at = now() WHERE id = 1$$);
SELECT itso_test.expect_ok('Thêm lại domain sau khi xóa mềm được chấp nhận',
  $$INSERT INTO domains (id, website_id, name) VALUES (2, 1, 'www.a.example.vn')$$);
SELECT itso_test.expect_error('Domain chữ hoa bị từ chối',
  $$INSERT INTO domains (website_id, name) VALUES (1, 'B.Example.VN')$$, '23514');
SELECT itso_test.expect_error('Website trùng primary_domain bị từ chối',
  $$INSERT INTO websites (hosting_account_id, server_id, primary_domain) VALUES (1, 1, 'a.example.vn')$$, '23505');
ROLLBACK;
