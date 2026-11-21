/**
 * Step-up MFA dùng chung: API trả 403 `mfa_step_up_required` cho thao tác nhạy cảm (xóa website, xóa provider
 * DNS…). `sendWith` gọi `requestStepUp()`; hộp thoại (`StepUpHost`) hỏi mã TOTP, gọi /auth/step-up rồi trả true
 * để gửi lại thao tác đúng một lần. Không có hộp thoại (test, trang đăng nhập) → false, lỗi gốc được ném ra.
 */
type Handler = () => Promise<boolean>;
let handler: Handler | null = null;

export function setStepUpHandler(h: Handler | null) {
  handler = h;
}

export function requestStepUp(): Promise<boolean> {
  return handler ? handler() : Promise.resolve(false);
}

export const STEP_UP_PATH = '/api/v1/auth/step-up';
