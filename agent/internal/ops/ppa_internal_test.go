package ops

import (
	"bytes"
	"strings"
	"testing"
)

// Khóa PPA nhúng phải đúng tập fingerprint ghim; khóa khác hoặc bị sửa bị từ chối (D-100).
func TestPinnedPPAKey(t *testing.T) {
	if err := verifyPinnedKey(ondrejKey, ondrejFingerprints); err != nil {
		t.Fatal(err)
	}
	if err := verifyPinnedKey(ondrejKey, []string{"14AA40EC0831756756D7F66C4F4EA0AAE5267A6C"}); err == nil {
		t.Fatal("thừa khóa so với bản ghim phải bị từ chối")
	}
	if err := verifyPinnedKey(ondrejKey, []string{"0000000000000000000000000000000000000000", "B8DC7E53946656EFBCE4C1DD71DAEAAB4AD4CAB6"}); err == nil {
		t.Fatal("fingerprint sai phải bị từ chối")
	}
	// Sửa một ký tự base64 trong thân khóa → fingerprint đổi hoặc không phân tích được.
	i := bytes.Index(ondrejKey, []byte("\n\n")) + 10
	bad := append([]byte(nil), ondrejKey...)
	if bad[i] == 'A' {
		bad[i] = 'B'
	} else {
		bad[i] = 'A'
	}
	if err := verifyPinnedKey(bad, ondrejFingerprints); err == nil {
		t.Fatal("khóa bị sửa phải bị từ chối")
	}
	if _, err := pgpFingerprints([]byte("không phải khóa")); err == nil {
		t.Fatal("dữ liệu rác phải lỗi")
	}
	if !strings.Contains(ppaSources, "Signed-By: "+ppaKeyPath) || strings.Contains(ppaSources, "trusted=yes") {
		t.Fatal("kho PPA phải signed-by riêng, không trusted=yes")
	}
}
