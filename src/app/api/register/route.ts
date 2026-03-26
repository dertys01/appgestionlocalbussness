import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Rate limiting simple par IP : max 3 tentatives par heure
const attempts = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  if (entry.count >= 3) return true;
  entry.count++;
  return false;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Trop de tentatives. Réessayez dans une heure.' },
        { status: 429 }
      );
    }

    const { email, password, businessName } = await req.json();
    if (!email || !password || !businessName) {
      return NextResponse.json({ error: 'Tous les champs sont requis.' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Mot de passe : 6 caractères minimum.' }, { status: 400 });
    }
    if (businessName.trim().length < 2) {
      return NextResponse.json({ error: 'Nom de boutique trop court.' }, { status: 400 });
    }

    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Créer le compte sans confirmation email
    const { data: newUser, error: signUpError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (signUpError) {
      const msg = signUpError.message.includes('already registered')
        ? 'Cet email est déjà utilisé.'
        : signUpError.message;
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    const userId = newUser.user.id;
    const slug = businessName.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '') + '-' + Math.random().toString(36).slice(2, 6);

    const { error: orgError } = await adminClient.from('organizations').insert({
      id: userId,
      name: businessName.trim(),
      slug,
      plan: 'free',
      onboarding_done: false,
    });

    if (orgError) {
      // Rollback : supprimer le user si l'org échoue
      await adminClient.auth.admin.deleteUser(userId);
      return NextResponse.json({ error: 'Erreur création boutique : ' + orgError.message }, { status: 500 });
    }

    // Connecter l'utilisateur via le client anon (retourne une session)
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data: session, error: loginError } = await anonClient.auth.signInWithPassword({ email, password });
    if (loginError || !session.session) {
      return NextResponse.json({ error: 'Compte créé, veuillez vous connecter.' }, { status: 200 });
    }

    return NextResponse.json({
      access_token: session.session.access_token,
      refresh_token: session.session.refresh_token,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
