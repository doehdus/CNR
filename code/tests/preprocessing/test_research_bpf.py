import csv
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
from scipy.signal import butter, sosfreqz

from analysis.mkgraphs.research_bpf import ROOT, CODE, transport


class ResearchBPFTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(dir=ROOT/'.cache/noise_analysis')
        cls.base=Path(cls.tmp.name);cls.engine=cls.base/'engine.exe'
        subprocess.run([str(ROOT/'.tools/tcc/tcc.exe'),'-std=c99','-Wall','-Werror',str(CODE),'-o',str(cls.engine)],check=True)

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()

    def example(self,candidates):
        directory=Path(tempfile.mkdtemp(dir=self.base));f=np.arange(1025)*16000/2048
        speech=np.exp(-((f-170)/100)**2)+.02*np.exp(-((f-5600)/700)**2)
        noise=.03+np.exp(-((f-80)/60)**2);speech[0]=0;noise[-1]=0
        rows=[{'id':'clean','kind':0,'noise':0,'arrays':[speech,speech,np.zeros(1025)]}]
        for i in (1,2,3):
            for kind in (2,3):rows.append({'id':f'n{i}_k{kind}','kind':kind,'noise':i,'arrays':[speech+noise,speech,noise]})
        source=directory/'input.txt';transport(source,candidates,rows)
        args=[str(self.engine),str(source),str(directory/'desc.csv'),str(directory/'metrics.csv'),str(directory/'cases.csv')]
        subprocess.run(args,check=True,capture_output=True)
        with (directory/'metrics.csv').open() as stream:metrics=list(csv.DictReader(stream))
        return directory,args,f,speech,noise,metrics

    def test_all_filter_types_orders_and_weak_speech_bands_match_independent_scipy(self):
        candidates=[{'id':'bypass','type':0,'lower_hz':0,'upper_hz':8000,'prototype_order':1}]
        for kind in (1,2,3):
            for order in (1,2,4,8,16):candidates.append({'id':f't{kind}_n{order}','type':kind,'lower_hz':80,'upper_hz':6500,'prototype_order':order})
        directory,_,f,s,n,metrics=self.example(candidates)
        for c,row in zip(candidates,metrics):
            if c['type']==0:g=np.ones(1025)
            else:
                shape={1:'highpass',2:'lowpass',3:'bandpass'}[c['type']]
                cutoff=80 if c['type']==1 else 6500 if c['type']==2 else [80,6500]
                sos=butter(c['prototype_order'],cutoff,btype=shape,fs=16000,output='sos')
                g=np.abs(sosfreqz(sos,worN=f,fs=16000)[1])**2
            retain=100*np.sum(s*g)/np.sum(s);drop=-10*np.log10(np.sum(n*g)/np.sum(n))
            self.assertAlmostEqual(float(row['clean_min_percent']),retain,places=9)
            self.assertAlmostEqual(float(row['noise_mean_db']),drop,places=9)
            self.assertAlmostEqual(float(row['snr_mean_db']),drop+10*np.log10(retain/100),places=9)
            for lo,hi,key in [(2000,4000,'clean_2_4k_min_percent'),(4000,8001,'clean_4_8k_min_percent')]:
                mask=(f>=lo)&(f<hi)
                self.assertAlmostEqual(float(row[key]),100*np.sum(s[mask]*g[mask])/np.sum(s[mask]),places=9)
        with (directory/'desc.csv').open() as stream:description=next(row for row in csv.DictReader(stream) if row['signal']=='speech')
        self.assertAlmostEqual(float(description['band_4000_6000_percent']),100*np.sum(s[(f>=4000)&(f<6000)])/np.sum(s),places=10)
        with (directory/'cases.csv').open() as stream:self.assertEqual(len(list(csv.DictReader(stream))),16*7)

    def test_existing_results_and_invalid_cutoffs_are_preserved(self):
        c={'id':'test','type':3,'lower_hz':80,'upper_hz':6500,'prototype_order':2}
        directory,args,*_=self.example([c]);before={p.name:p.read_bytes() for p in directory.iterdir()}
        self.assertNotEqual(subprocess.run(args,capture_output=True).returncode,0)
        self.assertEqual(before,{p.name:p.read_bytes() for p in directory.iterdir()})
        c['upper_hz']=8000
        with self.assertRaises(subprocess.CalledProcessError):self.example([c])

    def test_ranking_protects_weak_bands_and_excludes_dominated_candidates(self):
        executable=self.base/'rank.exe'
        subprocess.run([str(ROOT/'.tools/tcc/tcc.exe'),'-std=c99','-Wall','-Werror',str(CODE.with_name('rank_research_bpf.c')),'-o',str(executable)],check=True)
        directory=Path(tempfile.mkdtemp(dir=self.base));source=directory/'metrics.csv';out=directory/'rank.csv'
        with source.open('w',newline='') as stream:
            writer=csv.writer(stream);writer.writerow(['header']*19)
            for name,clean,band,noise in [('bypass',100,100,0),('a',99,100,1),('b',98,50,2),('c',90,98,3),('anchor',50,0,4)]:
                writer.writerow([name,1,80,8000,4,4,clean,clean,clean,band,band,noise,noise,noise,noise,noise,noise,noise,noise])
        subprocess.run([str(executable),str(source),str(out)],check=True)
        with out.open() as stream:rows={r['candidate_id']:r for r in csv.DictReader(stream)}
        self.assertEqual(rows['b']['pareto'],'0')
        self.assertEqual(rows['c']['frontier_rank'],'1')
        self.assertAlmostEqual(float(rows['c']['balanced_score']),.65)
        self.assertAlmostEqual(float(rows['b']['worst_speech_loss_metric_percent']),50)


if __name__=='__main__':unittest.main()
