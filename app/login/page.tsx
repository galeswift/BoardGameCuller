import { LockKeyhole, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export const metadata = { title: 'Collection Cull' };

// The front door: a demo for visitors, and the password sign-in for the owner.
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> })
{
    const { error } = await searchParams;

    return (
        <main className="workspace landing">
            <section className="message landing-card">
                <h1>Collection Cull</h1>
                <p>
                    Trim a board game collection: score every game you own, see which ones fill the same slot on your shelf, and trade in or
                    sell the ones you let go.
                </p>
                <form method="post" action="/api/demo">
                    <Button type="submit" size="lg">
                        <Sparkles /> Try the demo
                    </Button>
                </form>
                <p className="hint">The demo uses a sample collection of about 300 games. Nothing you change there is saved.</p>
            </section>

            <form method="post" action="/api/login" className="message landing-card">
                <h2>
                    <LockKeyhole /> Sign in
                </h2>
                <p>Enter the password to open your collection.</p>
                <Input type="password" name="password" autoComplete="current-password" required aria-label="Password" />
                {error ? <p className="landing-error">That password didn’t match.</p> : null}
                <Button type="submit" variant="outline">
                    Sign in
                </Button>
            </form>
        </main>
    );
}
