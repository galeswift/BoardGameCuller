import { redirect } from 'next/navigation';
import { getViewer } from './auth';
import CollectionApp from './collection-app';

export const dynamic = 'force-dynamic';

// Visitors without a session land on the front page, which offers the demo.
export default async function Home()
{
    if (!(await getViewer()))
    {
        redirect('/login');
    }

    return <CollectionApp />;
}
