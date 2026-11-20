import { useNavigate, useSearch } from '@tanstack/react-router';

type Search = Record<string, string | undefined>;

/**
 * Trạng thái trang lưu trên URL (?q=…&status=…&tab=…): chia sẻ link, back/forward giữ nguyên.
 * Giá trị rỗng bị xóa khỏi URL.
 */
export function useUrlState(): [Search, (patch: Search) => void] {
  const search = useSearch({ strict: false }) as Search;
  const navigate = useNavigate();
  const set = (patch: Search) => {
    void navigate({
      to: '.',
      replace: true,
      search: (prev: Search) =>
        Object.fromEntries(
          Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined && v !== ''),
        ),
    } as never);
  };
  return [search, set];
}
