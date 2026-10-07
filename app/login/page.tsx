import { LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const metadata = { title: 'Sign in · Collection Cull' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> })
{
    const { error } = await searchParams;
    return (
        <main className="workspace">
            <form method="post" action="/api/login" className="message" style={{ maxWidth: 420, margin: '80px auto' }}>
                <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <LockKeyhole /> Collection Cull
                </h2>
                <p>Enter the password to open your collection.</p>
                <Input type="password" name="password" autoComplete="current-password" required autoFocus aria-label="Password" />
                {error ? <p style={{ color: 'var(--destructive)' }}>That password didn’t match.</p> : null}
                <Button type="submit" style={{ marginTop: 14 }}>
                    Sign in
                </Button>
            </form>
        </main>
    );
}
