'use client';

import { useEffect, useState } from 'react';
import { UserPlus, Trash2, RefreshCw, Users, ClipboardList, Loader2, Link2, Copy, Check, MessageCircle, XCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useSupabase } from '@/components/providers/SupabaseProvider';
import { canAddEmployee, PLAN_LIMITS, PLAN_LABELS } from '@/lib/utils/plans';
import type { BusinessMember, ActivityLog } from '@/types';

type Panel = 'team' | 'logs';

type Invitation = {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
};

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  login:                  { label: 'Connexion',      color: 'bg-slate-100 text-slate-600' },
  sale:                   { label: 'Vente',           color: 'bg-indigo-100 text-indigo-700' },
  product_add:            { label: 'Produit ajouté',  color: 'bg-emerald-100 text-emerald-700' },
  product_edit:           { label: 'Produit modifié', color: 'bg-amber-100 text-amber-700' },
  product_delete:         { label: 'Produit supprimé',color: 'bg-red-100 text-red-700' },
  product_archive:        { label: 'Produit archivé', color: 'bg-slate-200 text-slate-600' },
  expense:                { label: 'Dépense',        color: 'bg-orange-100 text-orange-700' },
  restock:                { label: 'Réappro.',        color: 'bg-blue-100 text-blue-700' },
  inventory_adjustment:   { label: 'Inventaire',      color: 'bg-purple-100 text-purple-700' },
};

export function TeamModule() {
  const { supabase, user, isEmployee, plan } = useSupabase();
  // Un employé n'a accès qu'au journal : le panneau démarre directement dessus.
  // Sans cela, l'effet de chargement ne déclenchait que fetchMembers() et
  // fetchLogs() n'était jamais appelé — le journal restait vide pour tous les
  // employés, et l'appel /api/employees était gaspillé.
  const [panel, setPanel] = useState<Panel>(isEmployee ? 'logs' : 'team');
  const [members, setMembers] = useState<BusinessMember[]>([]);
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Formulaire d'invitation
  const [email, setEmail] = useState('');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [lastLink, setLastLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  const fetchInvitations = async () => {
    if (!user) return;
    try {
      const token = await getToken();
      if (!token) return;
      const res = await fetch('/api/invitations', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) return;
      setInvitations(json.invitations ?? []);
    } catch {
      // Les invitations en attente sont un complément : leur échec ne doit pas
      // masquer la liste des employés, déjà chargée par fetchMembers().
    }
  };

  const [logsPage, setLogsPage] = useState(0);
  const [hasMoreLogs, setHasMoreLogs] = useState(false);
  const [logsError, setLogsError] = useState('');
  const LOGS_PER_PAGE = 50;

  const fetchLogs = async (page = 0) => {
    if (!user) return;
    setLoadingLogs(true);
    setLogsError('');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('activity_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .range(page * LOGS_PER_PAGE, (page + 1) * LOGS_PER_PAGE);

      if (error) throw new Error(error.message);

      const rows = (data as ActivityLog[]) ?? [];
      setHasMoreLogs(rows.length > LOGS_PER_PAGE);
      const displayRows = rows.slice(0, LOGS_PER_PAGE);
      setLogs(page === 0 ? displayRows : (prev) => [...prev, ...displayRows]);
      setLogsPage(page);
    } catch (e) {
      // L'error était ignorée et loadingLogs restait bloqué à true en cas de
      // rejet : l'écran restait sur « Chargement... » indéfiniment.
      setLogsError((e as Error).message);
      setHasMoreLogs(false);
    } finally {
      setLoadingLogs(false);
    }
  };

  const loadMoreLogs = () => fetchLogs(logsPage + 1);

  useEffect(() => {
    if (isEmployee) {
      // Employé : jamais la liste d'équipe (et jamais l'appel API correspondant).
      fetchLogs(0);
      return;
    }
    if (panel === 'team') { fetchMembers(); fetchInvitations(); }
    else { setLogs([]); setLogsPage(0); fetchLogs(0); }
  }, [panel, user, isEmployee]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setLastLink('');

    if (!email.trim()) { setFormError('Saisissez l\'adresse email de l\'employé'); return; }

    // Les invitations en attente occupent déjà un poste au regard du plan : ne
    // pas les compter ici laisserait l'échec survenir plus tard, à l'acceptation,
    // sans raison visible pour l'utilisateur.
    if (!canAddEmployee(plan, members.length + invitations.length)) {
      setFormError(
        `Limite atteinte. Le plan ${PLAN_LABELS[plan]} autorise ${PLAN_LIMITS[plan]} employé(s), invitations en attente comprises. Passez au plan supérieur dans Paramètres.`
      );
      return;
    }

    setAdding(true);
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expirée. Veuillez vous reconnecter.');

      const res = await fetch('/api/invitations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ email }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `Erreur serveur (${res.status})`);

      setLastLink(json.url);
      setEmail('');
      fetchInvitations();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setFormError('Copie impossible. Sélectionnez le lien et copiez-le manuellement.');
    }
  };

  const revokeInvitation = async (id: string) => {
    setRevokingId(id);
    setFetchError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expirée. Veuillez vous reconnecter.');
      const res = await fetch(`/api/invitations?id=${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `Erreur serveur (${res.status})`);
      await fetchInvitations();
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setRevokingId(null);
    }
  };

  const handleDelete = async (memberId: string) => {
    setConfirmDeleteId(null);
    setDeletingId(memberId);
    setFetchError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Session expirée. Veuillez vous reconnecter.');

      const res = await fetch(`/api/employees/${memberId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `Erreur serveur (${res.status})`);

      await fetchMembers();
    } catch (e) {
      setFetchError((e as Error).message);
      await fetchMembers();
    } finally {
      setDeletingId(null);
    }
  };

  if (isEmployee) {
    // Les employés voient uniquement le journal
    return (
      <div className="space-y-4">
        {logsError && (
          <p className="text-red-500 text-xs rounded-lg bg-red-50 border border-red-200 px-3 py-2">
            {logsError}
          </p>
        )}
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
          {/* Invitation */}
          <Card className="border-indigo-200 bg-indigo-50">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 font-semibold text-indigo-700 text-sm">
                <UserPlus className="h-4 w-4" /> Inviter un employé
              </div>
              <p className="text-xs text-slate-600">
                Vous saisissez son adresse et vous lui transmettez le lien.
                <strong> C&apos;est lui qui choisit son mot de passe</strong> : vous n&apos;en
                connaissez jamais la valeur.
              </p>
              <form onSubmit={handleInvite} className="space-y-3">
                <Input
                  type="email"
                  placeholder="Adresse email de l'employé"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bg-white"
                  autoComplete="off"
                />
                {formError && <p className="text-red-500 text-sm">{formError}</p>}
                <Button type="submit" disabled={adding} className="w-full bg-indigo-600 hover:bg-indigo-700 gap-2">
                  {adding
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Création du lien…</>
                    : <><UserPlus className="h-4 w-4" /> Générer le lien</>}
                </Button>
              </form>

              {lastLink && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                  <p className="text-xs font-medium text-emerald-800">
                    Lien prêt. Transmettez-le à l&apos;employé, il expire dans 7 jours.
                  </p>
                  <p className="text-xs text-emerald-700 break-all font-mono bg-white rounded p-2 border border-emerald-100">
                    {lastLink}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => copyLink(lastLink)}
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? 'Copié' : 'Copier'}
                    </Button>
                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(
                        `Rejoignez la boutique sur GestionLocal : ${lastLink}`
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-medium h-8"
                    >
                      <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                    </a>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Invitations en attente */}
          {invitations.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-700">
                Invitations en attente ({invitations.length})
              </h3>
              {invitations.map((inv) => (
                <Card key={inv.id} className="border-amber-200 bg-amber-50">
                  <CardContent className="p-3 flex items-center gap-3">
                    <Link2 className="h-4 w-4 text-amber-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{inv.email}</div>
                      <div className="text-xs text-amber-700">
                        Expire le {new Date(inv.expires_at).toLocaleDateString('fr-FR')}
                      </div>
                    </div>
                    {revokingId === inv.id ? (
                      <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                    ) : (
                      <button
                        onClick={() => revokeInvitation(inv.id)}
                        title="Révoquer le lien"
                        className="p-1.5 text-amber-500 hover:text-red-600 rounded-lg shrink-0"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

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
