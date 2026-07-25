import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { VdmUser } from "@/types/vdm";

export function useVdmAuth() {
  const queryClient = useQueryClient();

  const meQuery = useQuery<VdmUser | null>({
    queryKey: ["vdm-me"],
    queryFn: async () => {
      try {
        return await api.get<VdmUser>("/api/vdm/auth/me");
      } catch {
        return null;
      }
    },
    retry: false,
    staleTime: 60_000,
  });

  const loginMutation = useMutation({
    mutationFn: (creds: { username: string; password: string }) =>
      api.post<{ ok: boolean; user: VdmUser }>("/api/vdm/auth/login", creds),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vdm-me"] }),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post("/api/vdm/auth/logout"),
    onSuccess: () => {
      queryClient.setQueryData(["vdm-me"], null);
      queryClient.clear();
    },
  });

  return {
    user: meQuery.data ?? null,
    isLoading: meQuery.isLoading,
    isAuthenticated: !!meQuery.data,
    isAdmin: meQuery.data?.role === "admin",
    login: loginMutation.mutateAsync,
    logout: logoutMutation.mutateAsync,
    loginError: loginMutation.error?.message ?? null,
    isLoggingIn: loginMutation.isPending,
  };
}
