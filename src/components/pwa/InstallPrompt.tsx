'use client';

import { useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { invitationARecevoir, modeOuverture, type InvitationInstallation } from '@/lib/pwa/installation';
import { consommerInvite, lireInvite, souscrireInvite } from '@/lib/pwa/invite';
import { lireRefus, marquerRefus } from '@/lib/pwa/refus';

/**
 * Bannière d'installation (P2), affichée sur l'accueil du commerçant.
 *
 * Trois états possibles : le bouton natif quand Chrome/Android l'offre,
 * la consigne Safari sur iOS, rien ailleurs (déjà installé, refus, ou
 * simplement pas d'invitation à offrir). Le refus est mémorisé : on ne
 * repropose pas la bannière à chaque visite.
 */

function estIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function InstallPrompt() {
  const [invitation, setInvitation] = useState<InvitationInstallation>({ type: 'aucune' });

  useEffect(() => {
    const recalculer = () => {
      setInvitation(
        invitationARecevoir({
          installe: modeOuverture() === 'standalone',
          inviteDisponible: lireInvite() !== null,
          ios: estIOS(),
          refusee: lireRefus(),
        })
      );
    };
    recalculer();
    return souscrireInvite(recalculer);
  }, []);

  const refuser = () => {
    marquerRefus();
    setInvitation({ type: 'aucune' });
  };

  const installer = async () => {
    const invite = consommerInvite();
    setInvitation({ type: 'aucune' });
    if (!invite) return;
    try {
      await invite.prompt();
      // 'accepted' comme 'dismissed' : le choix est fait, on n'insiste plus.
      await invite.userChoice;
    } catch {
      // Le navigateur peut refuser d'ouvrir le prompt : rien à signaler.
    }
  };

  if (invitation.type === 'aucune') return null;

  return (
    <div
      role="region"
      aria-label="Installation de l'application"
      className="flex items-start gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3"
    >
      <Download className="h-5 w-5 shrink-0 mt-0.5 text-indigo-600" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        {invitation.type === 'bouton' ? (
          <>
            <p className="text-sm text-slate-700">
              <span className="font-semibold text-slate-900">
                Ajoutez GestionLocal à votre écran d&apos;accueil&nbsp;:
              </span>{' '}
              elle s&apos;ouvre en plein écran, comme une application installée.
            </p>
            <button
              type="button"
              onClick={installer}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Installer
            </button>
          </>
        ) : (
          <p className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">
              Garder GestionLocal à portée de main&nbsp;:
            </span>{' '}
            sur iPhone ou iPad, touchez <Share className="mx-0.5 inline h-4 w-4 align-[-2px]" aria-label="Partager" />{' '}
            Partager, puis «&nbsp;Sur l&apos;écran d&apos;accueil&nbsp;».
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={refuser}
        aria-label="Masquer cette invitation"
        className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-indigo-100 hover:text-slate-600"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
