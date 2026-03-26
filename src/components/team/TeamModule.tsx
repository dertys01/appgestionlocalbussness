'use client';

import { useEffect, useState } from 'react';
import { UserPlus, Trash2, RefreshCw, Users, ClipboardList, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { canAddEmployee, PLAN_LIMITS, PLAN_LABELS } from '@/lib/utils/plans';
import type { BusinessMember, ActivityLog } from '@/types';

type Panel = 'team' | 'logs';

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  login:                  { label: 'Connexion',      color: 'bg-slate-100 text-slate-600' },
  sale:                   { label: 'Vente',           color: 'bg-indigo-100 text-indigo-700' },
  product_add:            { label: 'Produit ajouté',  color: 'bg-emerald-100 text-emerald-700' },
  product_edit:           { label: 'Produit modifié', color: 'bg-amber-100 text-amber-700' },
  product_delete:         { label: 'Produit supprimé',color: 'bg-red-100 text-red-700' },
  restock:                { label: 'Réappro.',        color: 'bg-blue-100 text-blue-700' },
  inventory_adjustment:   { label: 'Inventaire',      color: 'bg-purple-100 text-purple-700' },
};

export function TeamModule() {
  const { supabase, user, isEmployee, plan } = useSupabase();
  const [panel, setPanel] = useState<Panel>('team');
  const [members, setMembers] = useState<BusinessMember[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Formulaire ajout
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [formSuccess, setFormSuccess] = useState('');

  // Confirmation suppression
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState('');

  const getToken = async () => {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      const { data } = await supabase.auth.refreshSession();
      session = data.session;
    }
    return session?.access_token ?? null;
  };

  const fetchMembers = async () => {
    if (!user) return;
    setLoadingMembers(true);
    setFetchError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expirée. Veuillez vous reconnecter.');
      const res = await fetch('/api/employees', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Erreur serveur');
      setMembers(json.members ?? []);
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setLoadingMembers(false);
    }
  };

  const [logsPage, setLogsPage] = useState(0);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const LOGS_PER_PAGE = 50;

  const fetchLogs = async (page = 0) => {
    if (!user) return;
    setLoadingLogs(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * LOGS_PER_PAGE, (page + 1) * LOGS_PER_PAGE);
    const rows = (data as ActivityLog[]) ?? [];
    setHasMoreLogs(rows.length === LOGS_PER_PAGE + 1);
    const displayRows = rows.slice(0, LOGS_PER_PAGE);
    setLogs(page === 0 ? displayRows : (prev) => [...prev, ...displayRows]);
    setLogsPage(page);
    setLoadingLogs(false);
  };

  const loadMoreLogs = () => fetchLogs(logsPage + 1);

  useEffect(() => {
    if (panel === 'team') fetchMembers();
    else { setLogs([]); setLogsPage(0); fetchLogs(0); }
  }, [panel, user]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');
    if (!name || !email || !password) { setFormError('Tous les champs sont requis'); return; }
    if (password.length < 6) { setFormError('Mot de passe : 6 caractères minimum'); return; }

    if (!canAddEmployee(plan, members.length)) {
      setFormError(`Limite atteinte. Le plan ${PLAN_LABELS[plan]} autorise ${PLAN_LIMITS[plan].employees} employé(s). Passez au plan supérieur dans Paramètres.`);
      return;
    }

    setAdding(true);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch('/api/employees', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ name, email, password }),
    });
    const json = await res.json();
    setAdding(false);

    if (!res.ok) { setFormError(json.error); return; }

    setFormSuccess(`✅ ${name} peut maintenant se connecter avec ses identifiants`);
    setName(''); setEmail(''); setPassword('');
    fetchMembers();
  };

  const handleDelete = async (memberId: string) => {
    setConfirmDeleteId(null);
    const { data: { session } } = await supabase.auth.getSession();
    setDeletingId(memberId);
    const res = await fetch(`/api/employees/${memberId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session?.access_token}` },
    });
    if (!res.ok) {
      const json = await res.json();
      setFetchError(json.error ?? 'Erreur lors de la suppression');
    }
    setDeletingId(null);
    fetchMembers();
  };

  if (isEmployee) {
    // Les employés voient uniquement le journal
    return (
      <div className="space-y-4">
        <LogsPanel logs={logs} loading={loadingLogs} onRefresh={() => fetchLogs(0)} hasMore={hasMoreLogs} onLoadMore={loadMoreLogs} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setPanel('team')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            panel === 'team' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
          }`}
        >
          <Users className="h-4 w-4" /> Équipe
        </button>
        <button
          onClick={() => setPanel('logs')}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            panel === 'logs' ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-500 hover:bg-slate-50'
          }`}
        >
          <ClipboardList className="h-4 w-4" /> Journal
        </button>
      </div>

      {panel === 'team' && (
        <div className="space-y-4">
          {/* Formulaire ajout */}
          <Card className="border-indigo-200 bg-indigo-50">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 font-semibold text-indigo-700 text-sm">
                <UserPlus className="h-4 w-4" /> Ajouter un employé
              </div>
              <form onSubmit={handleAdd} className="space-y-3">
                <Input
                  placeholder="Nom affiché (ex: Marie)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="bg-white"
                />
                <Input
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-white"
                  autoComplete="off"
                />
                <div className="relative">
                  <Input
                    type={showPwd ? 'text' : 'password'}
                    placeholder="Mot de passe (min. 6 caractères)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="bg-white pr-10"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(!showPwd)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                  >
                    {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {formError && <p className="text-red-500 text-sm">{formError}</p>}
                {formSuccess && <p className="text-emerald-600 text-sm">{formSuccess}</p>}
                <Button type="submit" disabled={adding} className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2">
                  {adding ? <><Loader2 className="h-4 w-4 animate-spin" /> Création...</> : <><UserPlus className="h-4 w-4" /> Créer le compte</>}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Liste employés */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">
                Employés ({members.length})
              </h3>
              <button onClick={fetchMembers} disabled={loadingMembers} className="p-1.5 text-slate-400 hover:text-indigo-600">
                <RefreshCw className={`h-4 w-4 ${loadingMembers ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {fetchError && (
              <p className="text-red-500 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                {fetchError}
              </p>
            )}

            {members.length === 0 && !fetchError ? (
              <div className="text-center text-slate-400 py-8 text-sm">
                Aucun employé pour l&apos;instant
              </div>
            ) : (
              members.map((m) => (
                <div key={m.id}>
                  <Card className="border-slate-200">
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                        <span className="text-indigo-600 font-bold text-sm">
                          {m.member_name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-slate-800 text-sm">{m.member_name}</div>
                        <Badge className="bg-slate-100 text-slate-500 hover:bg-slate-100 text-xs mt-0.5">
                          {m.role}
                        </Badge>
                      </div>
                      {deletingId === m.member_id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-red-400" />
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(m.member_id)}
                          className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                          title="Supprimer"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </CardContent>
                  </Card>

                  {/* Confirmation inline */}
                  {confirmDeleteId === m.member_id && (
                    <Card className="border-red-200 bg-red-50 mt-1">
                      <CardContent className="p-3 flex items-center justify-between gap-3">
                        <p className="text-xs text-red-700 font-medium">
                          Supprimer <strong>{m.member_name}</strong> ? Cette action est irréversible.
                        </p>
                        <div className="flex gap-2 shrink-0">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeleteId(null)}
                            className="h-7 text-xs text-slate-600"
                          >
                            Annuler
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleDelete(m.member_id)}
                            className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white"
                          >
                            Confirmer
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {panel === 'logs' && (
        <LogsPanel logs={logs} loading={loadingLogs} onRefresh={() => fetchLogs(0)} hasMore={hasMoreLogs} onLoadMore={loadMoreLogs} />
      )}
    </div>
  );
}

function LogsPanel({ logs, loading, onRefresh, hasMore, onLoadMore }: {
  logs: ActivityLog[];
  loading: boolean;
  onRefresh: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{logs.length} actions chargées</p>
        <button onClick={onRefresh} disabled={loading} className="p-1.5 text-slate-400 hover:text-indigo-600">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading ? (
        <div className="text-center text-slate-400 py-10 text-sm">Chargement...</div>
      ) : logs.length === 0 ? (
        <div className="text-center text-slate-400 py-10 text-sm">Aucune activité</div>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => {
            const cfg = ACTION_LABELS[log.action] ?? { label: log.action, color: 'bg-slate-100 text-slate-600' };
            const date = new Date(log.created_at);
            const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
            const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

            return (
              <Card key={log.id} className="border-slate-200">
                <CardContent className="p-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-slate-800 text-sm">
                        {log.actor_name ?? log.actor_email}
                      </span>
                      <Badge className={`text-xs py-0 ${cfg.color}`}>{cfg.label}</Badge>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{log.description}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-slate-400">{dateStr}</div>
                    <div className="text-xs font-medium text-slate-600">{timeStr}</div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {hasMore && !loading && (
        <button
          onClick={onLoadMore}
          className="w-full py-2 text-sm text-indigo-600 hover:text-indigo-800 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors"
        >
          Charger plus
        </button>
      )}
      {loading && logs.length > 0 && (
        <p className="text-center text-xs text-slate-400 py-2">Chargement...</p>
      )}
    </div>
  );
}
